// Type declarations for fffleet (job contract v1).

import type { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';

export const CONTRACT_VERSION: 1;
export const KINDS: readonly ['stream', 'batch'];
export const STATES: readonly JobState[];
export const FILE_SCHEMES: readonly string[];
export const HTTP_SCHEMES: readonly string[];
export const PASSTHROUGH_SCHEMES: readonly string[];

export type JobKind = 'stream' | 'batch';
export type JobState = 'queued' | 'assigned' | 'staging' | 'running' | 'uploading' | 'succeeded' | 'failed' | 'cancelled';

export interface Endpoint {
  /** Name used in placeholders: {{input:name}} / {{output:name}}. */
  name: string;
  /** file:, http(s): (staged for batch jobs) or a live scheme such as rtmp:, srt:, udp:. */
  uri: string;
  /** Content-Type sent when an http(s) output is uploaded. */
  contentType?: string;
}

/** What a client submits. Only `kind` and `ffmpeg.args` are required. */
export interface JobSpecInput {
  contract?: 1;
  /** Client-chosen id; resubmitting the same id and spec is a no-op. */
  id?: string;
  kind: JobKind;
  /** Executor type, 'ffmpeg' by default. */
  type?: string;
  /** Slot pool to draw from, 'default' by default. */
  class?: string;
  /** -1000..1000, higher runs first. */
  priority?: number;
  owner?: string;
  /** Capabilities a worker must have, e.g. 'filter:ass', 'encoder:libx264', 'font:DejaVu Sans'. */
  requires?: string[];
  labels?: Record<string, string>;
  timeoutMs?: number | null;
  /** Keep ffmpeg's stdin open for writes through the API. */
  stdin?: boolean;
  inputs?: Endpoint[];
  outputs?: Endpoint[];
  ffmpeg?: { args: string[]; durationMs?: number | null };
  [section: string]: unknown;
}

export interface JobSpec extends Required<Omit<JobSpecInput, 'id' | 'ffmpeg'>> {
  id?: string;
  ffmpeg?: { args: string[]; durationMs: number | null };
}

export interface Progress {
  pct: number | null;
  outTimeMs: number | null;
  speed: number | null;
  fps: number | null;
  frame: number | null;
}

export interface JobError {
  code: string;
  message: string;
}

export interface OutputResult {
  name: string;
  uri: string;
  bytes: number | null;
}

export interface JobEvent {
  jobId: string;
  seq: number;
  at: string;
  state: JobState;
  progress?: Progress;
  workerId?: string | null;
  exitCode?: number | null;
  error?: JobError;
  outputs?: OutputResult[];
  stderrTail?: string;
}

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  type: string;
  class: string;
  owner: string;
  priority: number;
  labels: Record<string, string>;
  state: JobState;
  workerId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: Progress | null;
  exitCode: number | null;
  error: JobError | null;
  outputs: OutputResult[];
  stderrTail: string | null;
  seq: number;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ContractError extends Error {
  code: 'INVALID_SPEC';
  status: 422;
  errors: ValidationIssue[];
}

export class FleetError extends Error {
  constructor(code: string, message: string, opts?: { status?: number; details?: unknown });
  code: string;
  status: number;
  details?: unknown;
}

export function isFinal(state: string): boolean;
export function validateSpec(input: unknown): { ok: true; spec: JobSpec } | { ok: false; errors: ValidationIssue[] };
export function parseSpec(input: unknown): JobSpec;
export function resolvePlaceholders(args: string[], values: { input: Record<string, string>; output: Record<string, string> }): string[];
export function canonicalJson(value: unknown): string;

export interface ExecutorRuntime {
  workDir: string;
  signal: AbortSignal;
  setState(state: JobState, extra?: object): void;
  progress(progress: Progress): void;
  attachStdin(stdin: Writable | null): void;
  ffmpegPath?: string;
  fetch?: typeof fetch;
}

export interface ExecutorResult {
  exitCode?: number;
  outputs?: OutputResult[];
  stderrTail?: string | null;
}

export type Executor = (spec: JobSpec & { id: string }, runtime: ExecutorRuntime) => Promise<ExecutorResult>;

export interface JobManagerOptions {
  /** Slots per class pool, e.g. { default: 2, stream: 1 } or 'default=2,stream=1'. */
  slots?: Record<string, number> | string;
  workRoot?: string;
  ffmpegPath?: string;
  maxQueued?: number;
  keepFinished?: number;
  progressIntervalMs?: number;
  executors?: Record<string, Executor>;
  workerId?: string | null;
  fetch?: typeof fetch;
}

export interface PoolStats {
  total: number;
  used: number;
}

export class JobManager {
  constructor(opts?: JobManagerOptions);
  readonly slots: Record<string, number>;
  submit(spec: JobSpecInput): { created: boolean; queued?: boolean; job: JobSnapshot };
  get(id: string): JobSnapshot | null;
  list(): JobSnapshot[];
  activeIds(): string[];
  subscribe(id: string, afterSeq: number, listener: (event: JobEvent) => void): () => void;
  cancel(id: string): JobSnapshot | null;
  writeStdin(id: string, data: Buffer | string): Promise<{ bytes: number }>;
  stats(): { pools: Record<string, PoolStats>; queued: number; running: number };
  close(): Promise<void>;
}

export function normalizeSlots(slots: Record<string, number | string> | string): Record<string, number>;
export function runFfmpegJob(spec: JobSpec & { id: string }, runtime: ExecutorRuntime): Promise<Required<ExecutorResult>>;

export class JobHandle extends EventEmitter {
  readonly id: string;
  readonly where: 'local' | 'remote';
  state: JobState;
  snapshot: JobSnapshot | null;
  /** Resolves with the final snapshot whatever the outcome; check `state`. */
  readonly done: Promise<JobSnapshot>;
  cancel(): Promise<unknown>;
  write(data: Buffer | string): Promise<{ bytes: number }>;
  on(event: 'event', listener: (event: JobEvent) => void): this;
  on(event: 'state', listener: (state: JobState, event: JobEvent) => void): this;
  on(event: 'progress', listener: (progress: Progress, event: JobEvent) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}

export interface FleetOptions {
  /** A worker or an orchestrator. Without it every job runs on this machine. */
  url?: string;
  token?: string;
  /** 'local' (default) runs a job here when the remote cannot be reached or answers 502/503. */
  fallback?: 'local' | 'none';
  /** Options for the local runner. */
  local?: JobManagerOptions;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface Fleet {
  readonly mode: 'local' | 'remote';
  submit(spec: JobSpecInput): Promise<JobHandle>;
  capabilities(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export function createFleet(opts?: FleetOptions): Fleet;

export function createProgressParser(
  onBlock: (progress: Progress & { end: boolean }) => void,
  opts?: { durationMs?: number | null },
): (chunk: string | Buffer) => void;

export function detectCapabilities(ffmpegPath?: string): Promise<string[]>;
export function satisfies(capabilities: Iterable<string>, requires: string[]): boolean;

export function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (msg: { id: string | null; event: string; data: string }) => void,
): Promise<void>;

export function followJobEvents(opts: {
  url: string;
  headers?: Record<string, string>;
  onEvent: (event: JobEvent) => void;
  signal?: AbortSignal;
  maxRetries?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
}): Promise<JobEvent>;

export class JobRecord {
  constructor(spec: JobSpec & { id: string });
  readonly id: string;
  readonly final: boolean;
  state: JobState;
  push(fields: Partial<JobEvent>): JobEvent | null;
  subscribe(afterSeq: number, listener: (event: JobEvent) => void): () => void;
  snapshot(): JobSnapshot;
}

export function byPriority(a: JobRecord, b: JobRecord): number;
export function pruneFinished(jobs: Map<string, JobRecord>, keep: number): void;
