// Type declarations for fffleet/server: the HTTP job API used by fffleet-worker and fffleet-orchestrator.

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { JobEvent, JobSnapshot, JobSpecInput } from './index.js';

export interface JobBackend {
  submit(spec: JobSpecInput): { created: boolean; queued?: boolean; job: JobSnapshot } | Promise<{ created: boolean; queued?: boolean; job: JobSnapshot }>;
  get(id: string): JobSnapshot | null;
  list(): JobSnapshot[];
  cancel(id: string): JobSnapshot | null | Promise<JobSnapshot | null>;
  writeStdin(id: string, data: Buffer): Promise<{ bytes: number }>;
  subscribe(id: string, afterSeq: number, listener: (event: JobEvent) => void): () => void;
  capabilities(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createApiHandler(opts: {
  backend: JobBackend;
  token?: string | null;
  extraRoutes?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;
}): RequestHandler;
export function listen(handler: RequestHandler, opts?: { port?: number; host?: string }): Promise<{ server: Server; port: number; url: string }>;
export function close(server: Server): Promise<void>;
export function checkBearer(req: IncomingMessage, token: string | null): boolean;
export function send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
export function sendError(res: ServerResponse, err: unknown): void;
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer>;
export function readJson(req: IncomingMessage): Promise<unknown>;
