import { EventEmitter } from 'node:events';
import { isFinal } from './contract.js';

const HISTORY_LIMIT = 500;
let order = 0;

export class FleetError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, details?: any }} [extra]
   */
  constructor(code, message, { status = 500, details } = {}) {
    super(message);
    this.name = 'FleetError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/**
 * One job's state and its ordered event log. Shared by the local job manager and the orchestrator,
 * so both hand out the same snapshots and the same event stream.
 */
export class JobRecord {
  /** @param {import('./types.js').JobSpec & { id: string }} spec */
  constructor(spec) {
    this.spec = spec;
    this.id = spec.id;
    this.state = 'queued';
    this.workerId = null;
    this.createdAt = new Date().toISOString();
    this.order = ++order;
    this.startedAt = null;
    this.finishedAt = null;
    this.progress = null;
    this.exitCode = null;
    this.error = null;
    this.outputs = [];
    this.stderrTail = null;
    this.seq = 0;
    /** @type {import('./types.js').JobEvent[]} */
    this.history = [];
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
    this.push({ state: 'queued' });
  }

  get final() {
    return isFinal(this.state);
  }

  /**
   * Appends an event. A state change or a final result updates the snapshot too.
   * Events after the final one are ignored, so a job is final exactly once.
   * @param {Partial<import('./types.js').JobEvent>} fields
   */
  push(fields) {
    if (this.final) return null;
    const state = fields.state ?? this.state;
    const now = new Date().toISOString();
    if (state === 'running' && !this.startedAt) this.startedAt = now;
    if (fields.workerId !== undefined) this.workerId = fields.workerId;
    if (fields.progress) this.progress = fields.progress;
    this.state = state;
    if (isFinal(state)) {
      this.finishedAt = now;
      this.exitCode = fields.exitCode ?? null;
      this.error = fields.error ?? null;
      this.outputs = fields.outputs ?? [];
      this.stderrTail = fields.stderrTail ?? null;
    }
    const event = { jobId: this.id, seq: ++this.seq, at: now, state };
    for (const key of ['progress', 'workerId', 'exitCode', 'error', 'outputs', 'stderrTail']) {
      if (fields[key] !== undefined) event[key] = fields[key];
    }
    if (isFinal(state)) {
      event.exitCode = this.exitCode;
      event.outputs = this.outputs;
      if (this.error) event.error = this.error;
      if (this.stderrTail) event.stderrTail = this.stderrTail;
    }
    this.history.push(event);
    // Keep the first event and the newest ones; the final event is always the last one kept.
    if (this.history.length > HISTORY_LIMIT) this.history.splice(1, this.history.length - HISTORY_LIMIT);
    this.emitter.emit('event', event);
    return event;
  }

  /**
   * Replays events after `afterSeq`, then follows new ones. Returns an unsubscribe function.
   * @param {number} afterSeq
   * @param {(event: import('./types.js').JobEvent) => void} listener
   */
  subscribe(afterSeq, listener) {
    for (const e of this.history) if (e.seq > afterSeq) listener(e);
    if (this.final) return () => {};
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /** @returns {import('./types.js').JobSnapshot} */
  snapshot() {
    return {
      id: this.id,
      kind: this.spec.kind,
      type: this.spec.type,
      class: this.spec.class,
      owner: this.spec.owner,
      priority: this.spec.priority,
      labels: this.spec.labels,
      state: this.state,
      workerId: this.workerId,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      progress: this.progress,
      exitCode: this.exitCode,
      error: this.error,
      outputs: this.outputs,
      stderrTail: this.stderrTail,
      seq: this.seq,
    };
  }
}

/** Orders a queue: higher priority first, then oldest first. */
export function byPriority(a, b) {
  return b.spec.priority - a.spec.priority || a.order - b.order;
}

/**
 * Forgets the oldest finished jobs so at most `keep` finished ones stay in `jobs`.
 * Jobs that are still queued or running are never removed.
 * @param {Map<string, JobRecord>} jobs   in insertion (submit) order
 * @param {number} keep
 */
export function pruneFinished(jobs, keep) {
  let finished = 0;
  for (const r of jobs.values()) if (r.final) finished++;
  for (const [id, r] of jobs) {
    if (finished <= keep) break;
    if (!r.final) continue;
    jobs.delete(id);
    finished--;
  }
}
