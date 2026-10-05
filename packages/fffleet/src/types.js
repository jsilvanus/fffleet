// JSDoc type definitions for contract v1. TypeScript users get the same shapes from index.d.ts.

/**
 * @typedef {'stream' | 'batch'} JobKind
 * @typedef {'queued' | 'assigned' | 'staging' | 'running' | 'uploading' | 'succeeded' | 'failed' | 'cancelled'} JobState
 *
 * @typedef {object} Endpoint
 * @property {string} name   Referenced from args as {{input:name}} or {{output:name}}.
 * @property {string} uri    file:, http(s): or a passthrough scheme such as rtmp:.
 * @property {string} [contentType]
 *
 * @typedef {object} JobSpec
 * @property {1} contract
 * @property {string} [id]           Client-chosen id; makes submission idempotent.
 * @property {JobKind} kind
 * @property {string} type           Executor, 'ffmpeg' by default.
 * @property {string} class          Slot pool on the worker, 'default' by default.
 * @property {number} priority       Higher runs first.
 * @property {string} owner          Opaque label of whoever submitted the job.
 * @property {string[]} requires     Capabilities a worker must have, e.g. 'filter:ass'.
 * @property {Record<string, string>} labels
 * @property {number | null} timeoutMs
 * @property {boolean} stdin         Keep ffmpeg's stdin open for POST /v1/jobs/:id/stdin.
 * @property {boolean} stdout        Hand ffmpeg's stdout (`pipe:1`) to GET /v1/jobs/:id/stdout. Stream jobs only; no `-progress` is reported then.
 * @property {Endpoint[]} inputs
 * @property {Endpoint[]} outputs
 * @property {{ args: string[], durationMs: number | null }} [ffmpeg]
 *
 * @typedef {object} Progress
 * @property {number | null} pct
 * @property {number | null} outTimeMs
 * @property {number | null} speed
 * @property {number | null} fps
 * @property {number | null} frame
 *
 * @typedef {object} JobError
 * @property {string} code     INVALID_SPEC, FFMPEG_EXIT, TIMEOUT, INPUT_FAILED, UPLOAD_FAILED, WORKER_LOST, ...
 * @property {string} message
 *
 * @typedef {object} OutputResult
 * @property {string} name
 * @property {string} uri
 * @property {number | null} bytes
 *
 * @typedef {object} JobEvent
 * @property {string} jobId
 * @property {number} seq        Increases by one per job; resume with Last-Event-ID.
 * @property {string} at         ISO timestamp.
 * @property {JobState} state
 * @property {Progress} [progress]
 * @property {string} [workerId]
 * @property {number | null} [exitCode]
 * @property {JobError} [error]
 * @property {OutputResult[]} [outputs]
 * @property {string} [stderrTail]
 *
 * @typedef {object} JobSnapshot
 * @property {string} id
 * @property {JobKind} kind
 * @property {string} type
 * @property {string} class
 * @property {string} owner
 * @property {number} priority
 * @property {JobState} state
 * @property {string | null} workerId
 * @property {string} createdAt
 * @property {string | null} startedAt
 * @property {string | null} finishedAt
 * @property {Progress | null} progress
 * @property {number | null} exitCode
 * @property {JobError | null} error
 * @property {OutputResult[]} outputs
 * @property {string | null} stderrTail
 * @property {number} seq
 */

export {};
