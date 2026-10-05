/**
 * Where the orchestrator keeps its jobs between restarts. A store needs four methods:
 *
 *   save(job)     write or replace one job (JobRecord)
 *   loadAll()     every saved job, oldest first, as `{ spec, state, history, ... }`
 *   prune(keep)   forget the oldest finished jobs beyond `keep`
 *   close()
 *
 * The built-in one is a SQLite file through `node:sqlite`, loaded only when asked for (Node 22.13 or later).
 */

const FIELDS = ['state', 'workerId', 'createdAt', 'startedAt', 'finishedAt', 'progress', 'exitCode', 'error', 'outputs', 'stderrTail', 'seq', 'order', 'history'];
const SCHEMA_VERSION = 1;

/** @param {string} file */
export async function openSqliteJobStore(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (err) {
    throw new Error(`a state file needs node:sqlite (Node 22.13 or later): ${err.message}`);
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`state file ${file} was written by a newer fffleet (schema ${version}, this one knows ${SCHEMA_VERSION})`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, final INTEGER NOT NULL, data TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS jobs_final_ord ON jobs (final, ord)');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const upsert = db.prepare(
    'INSERT INTO jobs (id, ord, final, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET final = excluded.final, data = excluded.data',
  );
  const all = db.prepare('SELECT data FROM jobs ORDER BY ord');
  const prune = db.prepare('DELETE FROM jobs WHERE final = 1 AND ord <= (SELECT ord FROM jobs WHERE final = 1 ORDER BY ord DESC LIMIT 1 OFFSET ?)');

  return {
    save(job) {
      const data = { spec: job.spec };
      for (const key of FIELDS) data[key] = job[key];
      upsert.run(job.id, job.order, job.final ? 1 : 0, JSON.stringify(data));
    },
    loadAll() {
      const out = [];
      for (const row of all.all()) {
        try {
          out.push(JSON.parse(row.data));
        } catch {
          // A damaged row is skipped; the rest of the jobs still come back.
        }
      }
      return out;
    },
    prune(keep) {
      prune.run(Math.max(0, keep));
    },
    close() {
      db.close();
    },
  };
}
