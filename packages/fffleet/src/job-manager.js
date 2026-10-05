import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { KINDS, canonicalJson, implicitRequirements, parseSpec } from './contract.js';
import { createInputCache, parseSize } from './input-cache.js';
import { createS3Client } from './s3.js';
import { runFfmpegJob } from './executor.js';
import { FleetError, JobRecord, byPriority, pruneFinished } from './job-record.js';

/**
 * Runs jobs on this machine: a priority queue in front of per-class slot pools.
 * The local client mode and the worker daemon both use it, so a job behaves the
 * same whether it runs in-process or on a remote worker.
 *
 * Slots: `{ default: 2, stream: 1 }` means two jobs of any class plus one extra slot
 * reserved for class "stream". A class without its own pool uses "default".
 *
 * Events: 'job' (record) for every new job, 'transfer' ({ direction: 'in' | 'out', scheme, bytes })
 * after an input is staged or an output uploaded.
 */
export class JobManager extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {Record<string, number> | string} [opts.slots]   Pools, or 'auto' / 'auto:<cores per job>' to size them from this machine's CPUs.
   * @param {('batch' | 'stream')[]} [opts.kinds]             Job kinds this runner accepts (both by default).
   * @param {string} [opts.workRoot]
   * @param {string} [opts.ffmpegPath]
   * @param {number} [opts.maxQueued]
   * @param {number} [opts.keepFinished]          Finished jobs remembered for status and idempotency.
   * @param {number} [opts.progressIntervalMs]
   * @param {Record<string, Function>} [opts.executors]   type -> (spec, runtime) => Promise<result>
   * @param {string} [opts.workerId]
   * @param {typeof fetch} [opts.fetch]
   * @param {object | null} [opts.s3]   S3 settings (see s3ConfigFromEnv) or a client; enables s3: URIs.
   * @param {{ dir: string, maxBytes?: number | string } | null} [opts.cache]   Keeps staged s3: and http(s): inputs between jobs (least recently used removed above maxBytes, default 20 GB).
   */
  constructor({
    slots = { default: 2 },
    kinds = KINDS,
    workRoot = join(tmpdir(), 'fffleet'),
    ffmpegPath = 'ffmpeg',
    maxQueued = 1000,
    keepFinished = 1000,
    progressIntervalMs = 1000,
    executors = {},
    workerId = null,
    fetch: fetchImpl,
    s3 = null,
    cache = null,
  } = {}) {
    super();
    this.kinds = normalizeKinds(kinds);
    this.slots = normalizeSlots(slots, { kinds: this.kinds });
    this.used = Object.fromEntries(Object.keys(this.slots).map(k => [k, 0]));
    this.workRoot = workRoot;
    this.ffmpegPath = ffmpegPath;
    this.maxQueued = maxQueued;
    this.keepFinished = keepFinished;
    this.progressIntervalMs = progressIntervalMs;
    this.executors = { ffmpeg: runFfmpegJob, ...executors };
    this.workerId = workerId;
    this.fetch = fetchImpl;
    this.cache = cache ? createInputCache({ dir: cache.dir, maxBytes: cache.maxBytes === undefined ? undefined : parseSize(cache.maxBytes) }) : null;
    this.s3 = !s3 ? null : typeof s3.getFile === 'function' ? s3 : createS3Client({ fetch: fetchImpl, ...s3 });
    /** @type {Map<string, JobRecord & { run?: any }>} */
    this.jobs = new Map();
    /** @type {JobRecord[]} */
    this.queue = [];
    this.closed = false;
  }

  /** The pool a job class draws from. */
  poolFor(cls) {
    return this.slots[cls] !== undefined ? cls : 'default';
  }

  /**
   * Submits a job. Re-submitting the same id with the same spec returns the existing job.
   * @returns {{ created: boolean, queued?: boolean, job: import('./types.js').JobSnapshot }}
   */
  submit(input) {
    if (this.closed) throw new FleetError('SHUTTING_DOWN', 'job manager is closed', { status: 503 });
    const spec = parseSpec(input);
    spec.id ??= `job_${randomUUID()}`;

    const existing = this.jobs.get(spec.id);
    if (existing) {
      if (canonicalJson(existing.spec) !== canonicalJson(spec)) {
        throw new FleetError('ID_CONFLICT', `job ${spec.id} already exists with a different spec`, { status: 409 });
      }
      return { created: false, job: existing.snapshot() };
    }
    if (!this.kinds.includes(spec.kind)) {
      throw new FleetError('UNSUPPORTED_KIND', `this runner only takes ${this.kinds.join(' and ')} jobs`, { status: 422 });
    }
    if (!this.executors[spec.type]) {
      throw new FleetError('UNSUPPORTED_TYPE', `no executor for job type "${spec.type}"`, { status: 422 });
    }
    if (!this.s3 && implicitRequirements(spec).includes('scheme:s3')) {
      throw new FleetError('UNSUPPORTED_SCHEME', 's3: URIs need S3 credentials on this runner', { status: 422 });
    }
    const pool = this.poolFor(spec.class);
    if (this.slots[pool] === undefined || this.slots[pool] === 0) {
      throw new FleetError('NO_SLOTS', `no slot pool for class "${spec.class}"`, { status: 422 });
    }
    if (this.queue.length >= this.maxQueued) {
      throw new FleetError('QUEUE_FULL', 'queue is full', { status: 503 });
    }

    pruneFinished(this.jobs, this.keepFinished);
    const record = new JobRecord(spec);
    if (spec.stdout) record.stdoutPipe = new PassThrough();
    this.jobs.set(spec.id, record);
    this.queue.push(record);
    this.queue.sort(byPriority);
    this.emit('job', record);
    this.pump();
    return { created: true, queued: this.queue.includes(record), job: record.snapshot() };
  }

  get(id) {
    return this.jobs.get(id)?.snapshot() ?? null;
  }

  list() {
    return [...this.jobs.values()].map(r => r.snapshot());
  }

  /** Running and queued job ids (what a worker reports in its heartbeat). */
  activeIds() {
    return [...this.jobs.values()].filter(r => !r.final).map(r => r.id);
  }

  subscribe(id, afterSeq, listener) {
    const record = this.jobs.get(id);
    if (!record) throw new FleetError('NOT_FOUND', `job ${id} not found`, { status: 404 });
    return record.subscribe(afterSeq, listener);
  }

  /** Cancels a queued or running job. Returns the snapshot, or null if unknown. */
  cancel(id) {
    const record = this.jobs.get(id);
    if (!record) return null;
    if (record.final) return record.snapshot();
    const idx = this.queue.indexOf(record);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      record.push({ state: 'cancelled', error: { code: 'CANCELLED', message: 'cancelled before it started' } });
      record.stdoutPipe?.end();
      return record.snapshot();
    }
    record.run?.abort.abort(new FleetError('CANCELLED', 'cancelled'));
    return record.snapshot();
  }

  /** Writes to a running job's stdin (spec.stdin must be true). */
  async writeStdin(id, data) {
    const record = this.jobs.get(id);
    if (!record) throw new FleetError('NOT_FOUND', `job ${id} not found`, { status: 404 });
    if (!record.spec.stdin) throw new FleetError('NO_STDIN', 'job was not started with stdin: true', { status: 409 });
    const stdin = record.run?.stdin;
    if (!stdin || record.final) throw new FleetError('NOT_RUNNING', 'job is not running', { status: 409 });
    await new Promise((resolve, reject) => stdin.write(data, err => (err ? reject(err) : resolve())));
    return { bytes: Buffer.byteLength(data) };
  }

  /** Closes a running job's stdin (EOF to ffmpeg), e.g. after sending a whole input. */
  async closeStdin(id) {
    const record = this.jobs.get(id);
    if (!record) throw new FleetError('NOT_FOUND', `job ${id} not found`, { status: 404 });
    if (!record.spec.stdin) throw new FleetError('NO_STDIN', 'job was not started with stdin: true', { status: 409 });
    const stdin = record.run?.stdin;
    if (!stdin || record.final) throw new FleetError('NOT_RUNNING', 'job is not running', { status: 409 });
    await new Promise(resolve => stdin.end(resolve));
    return { closed: true };
  }

  /**
   * Opens a stdout job's output as a Readable (one reader per job; it ends when the job does).
   * Until a reader is attached ffmpeg stalls once the pipe's buffer is full.
   */
  openStdout(id) {
    const record = this.jobs.get(id);
    if (!record) throw new FleetError('NOT_FOUND', `job ${id} not found`, { status: 404 });
    if (!record.stdoutPipe) throw new FleetError('NO_STDOUT', 'job was not started with stdout: true', { status: 409 });
    if (record.stdoutOpened) throw new FleetError('STDOUT_TAKEN', 'stdout already has a reader', { status: 409 });
    record.stdoutOpened = true;
    return record.stdoutPipe;
  }

  stats() {
    const pools = Object.fromEntries(Object.keys(this.slots).map(k => [k, { total: this.slots[k], used: this.used[k] }]));
    return { pools, queued: this.queue.length, running: Object.values(this.used).reduce((a, b) => a + b, 0) };
  }

  /** Cancels everything and waits for running jobs to stop. */
  async close() {
    this.closed = true;
    const running = [...this.jobs.values()].filter(r => !r.final);
    for (const r of running) this.cancel(r.id);
    await Promise.all(running.map(r => r.run?.done).filter(Boolean));
  }

  pump() {
    for (const record of [...this.queue]) {
      const pool = this.poolFor(record.spec.class);
      if (this.used[pool] >= this.slots[pool]) continue;
      this.queue.splice(this.queue.indexOf(record), 1);
      this.used[pool]++;
      this.start(record, pool);
    }
  }

  start(record, pool) {
    const abort = new AbortController();
    const run = { abort, stdin: null, done: null, pid: null };
    record.run = run;
    let timer = null;
    if (record.spec.timeoutMs) {
      timer = setTimeout(() => abort.abort(new FleetError('TIMEOUT', `timed out after ${record.spec.timeoutMs} ms`)), record.spec.timeoutMs);
    }

    let lastProgressAt = 0;
    const workDir = join(this.workRoot, record.id.replace(/[^A-Za-z0-9._-]/g, '_'));
    const runtime = {
      workDir,
      signal: abort.signal,
      ffmpegPath: this.ffmpegPath,
      fetch: this.fetch,
      s3: this.s3,
      cache: this.cache,
      setState: (state, extra) => {
        if (extra?.pid) run.pid = extra.pid;
        if (!abort.signal.aborted) record.push({ state, ...(this.workerId ? { workerId: this.workerId } : {}) });
      },
      progress: p => {
        const now = Date.now();
        if (now - lastProgressAt < this.progressIntervalMs) {
          record.progress = p;
          return;
        }
        lastProgressAt = now;
        if (!abort.signal.aborted) record.push({ progress: p });
      },
      attachStdin: s => {
        run.stdin = s;
      },
      attachStdout: s => {
        if (record.stdoutPipe) s.pipe(record.stdoutPipe, { end: false });
      },
      transfer: (direction, scheme, bytes) => {
        if (bytes > 0) this.emit('transfer', { direction, scheme, bytes });
      },
    };

    run.done = (async () => {
      try {
        await mkdir(workDir, { recursive: true });
        abort.signal.throwIfAborted(); // cancelled before the executor could listen
        const result = await this.executors[record.spec.type](record.spec, runtime);
        const progress = record.progress && record.progress.pct !== null ? { ...record.progress, pct: 100 } : record.progress;
        record.push({ state: 'succeeded', progress, exitCode: result.exitCode ?? 0, outputs: result.outputs ?? [], stderrTail: result.stderrTail ?? null });
      } catch (err) {
        const reason = abort.signal.aborted ? abort.signal.reason : err;
        const cancelled = reason?.code === 'CANCELLED';
        record.push({
          state: cancelled ? 'cancelled' : 'failed',
          exitCode: reason?.details?.exitCode ?? null,
          error: { code: reason?.code ?? 'INTERNAL', message: reason?.message ?? String(reason) },
          stderrTail: reason?.details?.stderrTail ?? null,
        });
      } finally {
        clearTimeout(timer);
        record.stdoutPipe?.end();
        run.stdin = null;
        run.pid = null;
        this.used[pool]--;
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
        if (!this.closed) this.pump();
      }
    })();
  }
}

/** Parses "batch", "stream", "batch,stream" or an array into a list of job kinds. */
export function normalizeKinds(kinds) {
  const list = (typeof kinds === 'string' ? kinds.split(',') : kinds ?? []).map(k => String(k).trim()).filter(Boolean);
  if (!list.length) return [...KINDS];
  for (const k of list) if (!KINDS.includes(k)) throw new Error(`invalid job kind "${k}"; kinds are ${KINDS.join(' and ')}`);
  return [...new Set(list)];
}

/**
 * Slot pools sized from the CPU count. A batch job (an encode) is assumed to use about two cores,
 * a stream job (a relay or a light live encode) about one; `auto:N` sets the cores per slot.
 *
 * - batch and stream: `default` for batch work plus a separate `stream` pool of a quarter of the cores.
 * - batch only: `default` = cores / 2.
 * - stream only: `default` = cores.
 *
 * @param {{ cpus?: number, kinds?: string[], coresPerSlot?: number }} [opts]
 */
export function autoSlots({ cpus = availableParallelism(), kinds = KINDS, coresPerSlot } = {}) {
  const streamOnly = kinds.length === 1 && kinds[0] === 'stream';
  const per = coresPerSlot ?? (streamOnly ? 1 : 2);
  const slots = { default: Math.max(1, Math.floor(cpus / per)) };
  if (kinds.includes('batch') && kinds.includes('stream') && coresPerSlot === undefined) slots.stream = Math.max(1, Math.floor(cpus / 4));
  return slots;
}

/**
 * Parses "default=2,stream=1", "auto", "auto:1" or an object into { pool: count }.
 * @param {string | Record<string, number | string>} slots
 * @param {{ kinds?: string[], cpus?: number }} [opts]   used by "auto"
 */
export function normalizeSlots(slots, { kinds = KINDS, cpus } = {}) {
  const auto = typeof slots === 'string' ? slots.trim().match(/^auto(?::(\d+(?:\.\d+)?))?$/) : null;
  if (auto) {
    const coresPerSlot = auto[1] === undefined ? undefined : Number(auto[1]);
    if (coresPerSlot !== undefined && !(coresPerSlot > 0)) throw new Error(`invalid slots "${slots}": cores per slot must be above 0`);
    return autoSlots({ kinds, cpus, coresPerSlot });
  }
  const obj = typeof slots === 'string'
    ? Object.fromEntries(slots.split(',').map(s => s.trim()).filter(Boolean).map(s => s.split('=').map(x => x.trim())))
    : slots;
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const n = Number(v);
    if (!/^[a-z0-9_-]{1,32}$/.test(k) || !Number.isInteger(n) || n < 0) throw new Error(`invalid slot pool ${k}=${v}`);
    out[k] = n;
  }
  if (!Object.keys(out).length) throw new Error('at least one slot pool is required');
  return out;
}
