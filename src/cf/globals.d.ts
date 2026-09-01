// Minimal workerd global shapes used by src/cf/*.
//
// Deliberately structural and tiny instead of pulling in
// @cloudflare/workers-types wholesale: that package re-declares fetch/Response
// and collides with bun-types in the main tsconfig. These declarations cover
// exactly the bindings and scheduler types the Worker entry touches and do
// not overlap with anything bun-types declares.

interface D1Result<T = unknown> {
  results?: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
  withSession(constraintOrBookmark?: string): D1DatabaseSession;
}

interface D1DatabaseSession {
  prepare(query: string): D1PreparedStatement;
  run<T = unknown>(...statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface R2Bucket {
  get(key: string, options?: Record<string, unknown>): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: Record<string, unknown>,
  ): Promise<R2Object>;
  delete(keys: string | string[]): Promise<void>;
  head(key: string): Promise<R2Object | null>;
}

interface R2Object {
  key: string;
  size: number;
  uploaded: Date;
  httpEtag: string;
  customHttpMetadata?: Record<string, string>;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  blob(): Promise<Blob>;
}

interface KVNamespace {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' }): Promise<string | null>;
  put(key: string, value: string | ReadableStream | ArrayBuffer | ArrayBufferView, options?: {
    expirationTtl?: number;
    expiration?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
  readonly noRetry?: boolean;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ExportedHandler<Env = Record<string, unknown>> {
  fetch?(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void | Promise<void>;
}
