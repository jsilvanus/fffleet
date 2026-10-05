// Type declarations for fffleet/server: the HTTP job API used by fffleet-worker and fffleet-orchestrator.

import type { KeyObject } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { JobEvent, JobSnapshot, JobSpecInput, Scope } from './index.js';

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

/** Who a request is from. Without `admin` a principal only sees and controls its own jobs. */
export interface Principal {
  sub: string;
  scopes: Set<Scope>;
  admin: boolean;
}

export type Authenticator = (req: IncomingMessage) => Promise<Principal | null>;

export function createApiHandler(opts: {
  backend: JobBackend;
  /** A static admin token; ignored when `authenticate` is given. */
  token?: string | null;
  authenticate?: Authenticator;
  /** Renders the Prometheus text for GET /metrics (needs the `metrics` scope). */
  metrics?: (() => Promise<string>) | null;
  extraRoutes?: (req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal | null) => boolean | Promise<boolean>;
}): RequestHandler;
/** Sends 401 or 403 and returns false when `who` lacks `scope`. */
export function allowed(res: ServerResponse, who: Principal | null, scope: Scope): who is Principal;
export function listen(handler: RequestHandler, opts?: { port?: number; host?: string }): Promise<{ server: Server; port: number; url: string }>;
export function close(server: Server): Promise<void>;
export function checkBearer(req: IncomingMessage, token: string | null): boolean;
export function send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
export function sendError(res: ServerResponse, err: unknown): void;
export function getStream(url: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<import('node:http').IncomingMessage>;
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer>;
export function readJson(req: IncomingMessage): Promise<unknown>;

export const METRICS_CONTENT_TYPE: string;
export class Registry {
  counter(name: string, help: string, labelNames?: string[]): { inc(labels?: Record<string, string>, n?: number): void };
  gauge(name: string, help: string, labelNames?: string[]): { set(labels: Record<string, string>, v: number): void; inc(labels?: Record<string, string>, n?: number): void; reset(): void };
  histogram(name: string, help: string, labelNames?: string[], buckets?: number[]): { observe(labels: Record<string, string>, v: number): void };
  /** Runs before every render, to refresh gauges. */
  collect(fn: () => void | Promise<void>): void;
  render(): Promise<string>;
}
export function jobMetrics(registry: Registry, records: () => Iterable<unknown>): { track(record: unknown): void };
export function processMetrics(registry: Registry): void;
export function hostMetrics(registry: Registry, dir?: string): void;
export function procStats(pid: number): Promise<{ cpuSeconds: number; rssBytes: number } | null>;

export const SCOPES: readonly Scope[];
export function hashSecret(secret: string): Promise<string>;
export function verifySecret(secret: string, stored: string | undefined): Promise<boolean>;
export function generateSecret(): string;
export function loadSigningKey(path?: string | null): KeyObject;
export interface TokenSigner {
  kid: string;
  issuer: string;
  ttlSeconds: number;
  publicKey: KeyObject;
  sign(claims: { sub: string; scope: string[] }): string;
  jwks(): { keys: Record<string, unknown>[] };
}
export function createTokenSigner(opts: { privateKey: KeyObject | string; issuer?: string; ttlSeconds?: number }): TokenSigner;
export function createTokenVerifier(opts: { getKey: (kid: string) => KeyObject | null | Promise<KeyObject | null>; issuer?: string }): (token: string) => Promise<{ sub: string; scope: string[]; exp: number } | null>;
export function createRemoteKeySet(url: string, opts?: { fetch?: typeof fetch; minRefreshMs?: number }): (kid: string) => Promise<KeyObject | null>;
export function createAuthenticator(opts: {
  token?: string | null;
  verify?: ((token: string) => Promise<{ sub: string; scope: string[] } | null>) | null;
  isActive?: (sub: string) => boolean;
  open?: boolean;
}): Authenticator;
export interface ClientEntry {
  id: string;
  secretHash: string;
  scopes?: Scope[];
}
export function createClientStore(source: string | ClientEntry[] | null): { get(id: string): ClientEntry | null; has(id: string): boolean; readonly size: number } | null;
export function issueToken(opts: { req: IncomingMessage; body: unknown; clients: ReturnType<typeof createClientStore>; signer: TokenSigner }): Promise<{ status: number; body: Record<string, unknown>; headers?: Record<string, string> }>;
export function principal(sub: string, scopes: Iterable<Scope>): Principal;
export function bearerOf(req: IncomingMessage): string | null;
export const OPEN: Principal;
