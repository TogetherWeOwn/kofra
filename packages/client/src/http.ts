/**
 * Fetch-only HTTP transport for the Kofra REST API (v1). Runtime-neutral: it
 * uses only fetch, Request and Response, so the same code runs in Node (the
 * CLI), inside the Workers runtime and in browsers.
 */
import { VERSION } from "./version.ts";

/** Prefix of the request headers before the rename; old instances read only these. */
const LEGACY_HEADER_PREFIX = "X-Dropway-"; // rebrand:keep

/** One suggested follow-up call from the server error envelope. Data only: never executed. */
export interface DropwayNextCall {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

/** An error with a stable code, a hint for the caller and whether to retry. */
export class DropwayError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  /** Optional server delay guidance (null = no guidance); scheduling still uses Retry-After/backoff. */
  readonly retryAfterSeconds: number | null | undefined;
  /** Optional server docs reference; informational, never fetched. */
  readonly docs: string | undefined;
  /** Optional suggested follow-up calls; informational, never executed. */
  readonly next: DropwayNextCall[] | undefined;

  constructor(opts: {
    code: string;
    message: string;
    hint?: string;
    retryable: boolean;
    status?: number;
    requestId?: string;
    details?: Record<string, unknown>;
    retryAfterSeconds?: number | null;
    docs?: string;
    next?: DropwayNextCall[];
  }) {
    super(opts.message);
    this.name = "DropwayError";
    this.code = opts.code;
    this.hint = opts.hint;
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.details = opts.details;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.docs = opts.docs;
    this.next = opts.next;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
      retryable: this.retryable,
      ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      ...(this.docs !== undefined ? { docs: this.docs } : {}),
      ...(this.next !== undefined ? { next: this.next } : {}),
      ...(this.details ? { details: this.details } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

export type FetchLike = (input: Request) => Promise<Response>;

export interface ClientOptions {
  /** Instance origin, e.g. https://kofra.example.workers.dev (no /api/v1). */
  api: string;
  /** API key (dw_...), claim token (dwc_...) or bootstrap secret. null = anonymous. */
  token: string | null;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: FetchLike;
  /** Sent as X-Kofra-Client (attribution shown per version). */
  client?: string;
  /** Attempts for retryable failures (429, 5xx, network). Default 4. */
  attempts?: number;
  /** Base backoff in ms (doubles each attempt, plus jitter). Default 500. */
  backoffMs?: number;
  /** Longest Retry-After we are willing to sleep, in seconds. Default 30. */
  maxRetryAfterSeconds?: number;
  /**
   * Called once when the instance answers with a `Link: <...>; rel="successor-version"` on another
   * origin (it moved; the old origin still works). A `Deprecation` header is optional.
   */
  onMoved?: (newOrigin: string) => void;
}

/** The successor origin named by a deprecated response, or null. */
export function movedTo(res: Response, current: string): string | null {
  const m = /<([^>]+)>\s*;\s*rel="?successor-version"?/i.exec(res.headers.get("link") ?? "");
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(m[1]!);
  } catch {
    return null;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== current ? url.origin : null;
}

export interface RequestOptions {
  /** JSON body (sets Content-Type). */
  json?: unknown;
  /** Raw body (blob uploads, zips). */
  body?: Blob | Uint8Array | ArrayBuffer | string | null;
  headers?: Record<string, string>;
  /**
   * "safe": retry on 429, 5xx and network errors (GET, PUT blob, finalize: all idempotent).
   * "rate-limit": retry only on 429 (the server refused before doing anything).
   */
  retry?: "safe" | "rate-limit";
  /** Override the bearer token for this call (null = none). */
  token?: string | null;
  /** Allowed non-2xx statuses that should be returned instead of thrown. */
  accept?: number[];
  /** Sent as Idempotency-Key (the server replays repeats for idempotent operations). */
  idempotencyKey?: string;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export interface BytesResult {
  status: number;
  data: Uint8Array;
  contentType: string | null;
  headers: Headers;
}

/** Normalise "https://x.dev/", "x.dev", "https://x.dev/api/v1" to "https://x.dev". */
export function normaliseApi(input: string): string {
  let s = input.trim();
  if (!s) throw new DropwayError({ code: "invalid_api_url", message: "The instance URL is empty.", retryable: false });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${/^(localhost|127\.|\[::1\])/.test(s) ? "http" : "https"}://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new DropwayError({ code: "invalid_api_url", message: `"${input}" is not a valid URL.`, hint: "Use the instance origin, e.g. https://kofra.example.workers.dev", retryable: false });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DropwayError({ code: "invalid_api_url", message: `"${input}" must be an http(s) URL.`, retryable: false });
  }
  return url.origin;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Registry routing metadata for one operation (the generated OPERATIONS table). */
export interface OperationMeta {
  method: string;
  path: string;
}

export interface CallOptions {
  headers?: Record<string, string>;
  token?: string | null;
  accept?: number[];
  idempotencyKey?: string;
  retry?: "safe" | "rate-limit";
}

function queryValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(queryValue);
  if (value !== null && typeof value === "object") return [JSON.stringify(value)];
  return [String(value)];
}

export class DropwayHttpClient {
  readonly api: string;
  token: string | null;
  protected readonly doFetch: FetchLike;
  protected readonly clientName: string;
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly maxRetryAfter: number;
  private onMoved: ((newOrigin: string) => void) | undefined;

  constructor(opts: ClientOptions) {
    this.api = normaliseApi(opts.api);
    this.token = opts.token;
    this.doFetch = opts.fetch ?? ((req) => fetch(req));
    this.clientName = opts.client ?? `dropway-client/${VERSION}`;
    this.attempts = Math.max(1, opts.attempts ?? 4);
    this.backoffMs = opts.backoffMs ?? 500;
    this.maxRetryAfter = opts.maxRetryAfterSeconds ?? 30;
    this.onMoved = opts.onMoved;
  }

  /** Absolute URL for an API path ("/sites" -> <api>/api/v1/sites); absolute URLs pass through. */
  url(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    const p = path.startsWith("/") ? path : `/${path}`;
    return p.startsWith("/api/") || p === "/openapi.json" || p === "/llms.txt" ? `${this.api}${p}` : `${this.api}/api/v1${p}`;
  }

  /** Call the API and parse JSON. Throws DropwayError for non-2xx answers (unless accepted). */
  async request<T = Record<string, unknown>>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const { body, headers } = requestBody(opts);
    const res = await this.send(method, this.url(path), body, headers, opts);
    return { status: res.status, data: (await parseBody(res)) as T, headers: res.headers };
  }

  /** Call the API and read raw bytes (file downloads). Throws DropwayError on failures. */
  async requestBytes(method: string, path: string, opts: RequestOptions = {}): Promise<BytesResult> {
    const { body, headers } = requestBody(opts);
    const res = await this.send(method, this.url(path), body, headers, opts);
    return {
      status: res.status,
      data: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type"),
      headers: res.headers,
    };
  }

  private async send(
    method: string,
    url: string,
    body: Blob | Uint8Array | ArrayBuffer | string | null,
    headers: Record<string, string>,
    opts: RequestOptions,
  ): Promise<Response> {
    const token = opts.token === undefined ? this.token : opts.token;
    const retry = opts.retry ?? (method === "GET" || method === "HEAD" ? "safe" : "rate-limit");
    let lastError: DropwayError | null = null;

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const sent = new Headers(headers);
      sent.set("Accept", "application/json");
      sent.set("X-Kofra-Client", this.clientName);
      sent.set(`${LEGACY_HEADER_PREFIX}Client`, this.clientName); // instances from before the rename
      if (token) sent.set("Authorization", `Bearer ${token}`);
      if (opts.idempotencyKey) sent.set("Idempotency-Key", opts.idempotencyKey);
      let res: Response;
      try {
        res = await this.doFetch(new Request(url, { method, headers: sent, body, redirect: "follow" }));
      } catch (e) {
        lastError = new DropwayError({
          code: "network_error",
          message: `Could not reach ${new URL(url).origin}: ${(e as Error)?.message ?? String(e)}`,
          hint: "Check the instance URL (--api or KOFRA_API) and your network, then retry.",
          retryable: true,
        });
        if (retry === "safe" && attempt < this.attempts) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw lastError;
      }

      const successor = this.onMoved ? movedTo(res, this.api) : null;
      if (successor && this.onMoved) {
        const notify = this.onMoved;
        this.onMoved = undefined;
        notify(successor);
      }

      if (res.ok || opts.accept?.includes(res.status)) {
        return res;
      }

      const err = await errorFromResponse(res);
      const retryable = res.status === 429 || (retry === "safe" && res.status >= 500);
      if (retryable && attempt < this.attempts) {
        const ra = Number(res.headers.get("retry-after"));
        if (res.status === 429 && Number.isFinite(ra) && ra > this.maxRetryAfter) throw err;
        await sleep(res.status === 429 && Number.isFinite(ra) && ra > 0 ? ra * 1000 : this.backoff(attempt));
        lastError = err;
        continue;
      }
      throw err;
    }
    throw lastError ?? new DropwayError({ code: "request_failed", message: `${method} ${url} failed.`, retryable: false });
  }

  private backoff(attempt: number): number {
    const base = this.backoffMs * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * (base / 2));
  }

  get<T = Record<string, unknown>>(path: string, opts?: RequestOptions) {
    return this.request<T>("GET", path, opts);
  }

  post<T = Record<string, unknown>>(path: string, json?: unknown, opts: RequestOptions = {}) {
    return this.request<T>("POST", path, { ...opts, json: json ?? {} });
  }

  /** Fill `{params}` from the input; the rest goes to the query string (GET/HEAD) or the JSON body. */
  protected splitInput(op: OperationMeta, input: Record<string, unknown>): { url: string; json: Record<string, unknown> } {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new DropwayError({ code: "invalid_input", message: `Call ${op.method} ${op.path} with an object.`, retryable: false });
    }
    const path = op.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = input[name];
      if (value === undefined || value === null || typeof value === "object") {
        throw new DropwayError({
          code: "invalid_input",
          message: `Call ${op.method} ${op.path} is missing the path parameter "${name}".`,
          hint: "Pass every {parameter} in the input object.",
          retryable: false,
        });
      }
      return encodeURIComponent(String(value));
    });
    const names = new Set([...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !names.has(key)));
    if (op.method === "GET" || op.method === "HEAD") {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(rest)) {
        if (value === undefined || value === null) continue;
        for (const part of queryValue(value)) query.append(key, part);
      }
      const suffix = query.size > 0 ? `?${query}` : "";
      return { url: `${this.url(path)}${suffix}`, json: {} };
    }
    return { url: this.url(path), json: rest };
  }

  /** Call a JSON operation by its registry metadata (used by the generated typed methods). */
  async call<I, O>(op: OperationMeta, input: I, opts: CallOptions = {}): Promise<O> {
    const { url, json } = this.splitInput(op, input as Record<string, unknown>);
    const isQuery = op.method === "GET" || op.method === "HEAD";
    const res = await this.request<O>(op.method, url, isQuery ? { ...opts } : { ...opts, json });
    return res.data;
  }

  /** Call a bytes-out operation (reads raw bytes instead of parsing JSON). */
  async callBytes(op: OperationMeta, input: Record<string, unknown>, opts: CallOptions = {}): Promise<BytesResult> {
    const { url, json } = this.splitInput(op, input);
    const isQuery = op.method === "GET" || op.method === "HEAD";
    return this.requestBytes(op.method, url, isQuery ? { ...opts } : { ...opts, json });
  }

  /** Call a bytes-in operation (the payload is raw bytes, not JSON). */
  async callRaw<I, O>(
    op: OperationMeta,
    input: I,
    body: Uint8Array | ArrayBuffer | Blob | string,
    opts: CallOptions = {},
  ): Promise<O> {
    const { url, json } = this.splitInput(op, input as Record<string, unknown>);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(json)) {
      if (value === undefined || value === null) continue;
      for (const part of queryValue(value)) query.append(key, part);
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    const headers = { "Content-Type": "application/octet-stream", ...opts.headers };
    const res = await this.request<O>(op.method, `${url}${suffix}`, { ...opts, headers, body });
    return res.data;
  }
}

function requestBody(opts: RequestOptions): {
  body: Blob | Uint8Array | ArrayBuffer | string | null;
  headers: Record<string, string>;
} {
  let body: Blob | Uint8Array | ArrayBuffer | string | null | undefined = opts.body;
  const headers = { ...opts.headers };
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  return { body: body ?? null, headers };
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/** Optional envelope delay: null (no guidance) or a safe non-negative integer. Anything else is dropped. */
function validRetryAfterSeconds(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Optional docs reference: kept only when it is a plain string. */
function validDocs(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Optional suggested calls: kept only when every entry allowlists to
 * {tool, args, why}. Anything else (including extra fields on an entry)
 * drops the whole field rather than copying raw envelope data.
 */
function validNext(value: unknown): DropwayNextCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const calls: DropwayNextCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const { tool, args, why } = item as Record<string, unknown>;
    if (typeof tool !== "string" || typeof why !== "string") return undefined;
    if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
    calls.push({ tool, args: args as Record<string, unknown>, why });
  }
  return calls;
}

/** Turn an error response (the API's {error:{code,message,hint,details}} envelope or anything else) into a DropwayError. */
export async function errorFromResponse(res: Response): Promise<DropwayError> {
  const body = (await parseBody(res)) as {
    error?: {
      code?: string;
      message?: string;
      hint?: string;
      details?: Record<string, unknown>;
      retryable?: unknown;
      retryAfterSeconds?: unknown;
      docs?: unknown;
      next?: unknown;
    };
    requestId?: string;
    text?: string;
  };
  const e = body?.error;
  const requestId = body?.requestId ?? res.headers.get("x-request-id") ?? undefined;
  if (e && typeof e === "object" && e.code) {
    return new DropwayError({
      code: e.code,
      message: e.message ?? `HTTP ${res.status}`,
      hint: e.hint,
      details: e.details,
      status: res.status,
      requestId,
      retryable: typeof e.retryable === "boolean" ? e.retryable : res.status === 429 || res.status >= 500,
      retryAfterSeconds: validRetryAfterSeconds(e.retryAfterSeconds),
      docs: validDocs(e.docs),
      next: validNext(e.next),
    });
  }
  const snippet = (body?.text ?? "").replace(/\s+/g, " ").slice(0, 200);
  return new DropwayError({
    code: `http_${res.status}`,
    message: `The server answered HTTP ${res.status}${snippet ? `: ${snippet}` : ""}.`,
    hint: res.status === 404 ? "Is this a Kofra instance? Check --api / KOFRA_API (use the origin, without /api/v1)." : undefined,
    status: res.status,
    requestId,
    retryable: res.status === 429 || res.status >= 500,
  });
}
