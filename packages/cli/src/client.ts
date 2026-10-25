/**
 * HTTP client for the Kofra REST API (v1). The transport is @dropway/client
 * (fetch-only, so the same code runs in Node and inside the Workers runtime);
 * this module layers the CLI's process exit codes on top of it.
 */
import {
  DropwayClient as SdkDropwayClient,
  DropwayError,
  errorFromResponse as sdkErrorFromResponse,
  movedTo,
  normaliseApi as sdkNormaliseApi,
  type ApiResponse,
  type BytesResult,
  type CallOptions,
  type ClientOptions,
  type OperationMeta,
  type RequestOptions,
} from "@dropway/client";
import { VERSION } from "./version.ts";

/** Process exit codes. Stable: agents branch on them. */
export const EXIT = {
  ok: 0,
  /** Unexpected failure (a bug, or a response we could not understand). */
  error: 1,
  /** Bad command line, refused without --yes, or files that look like secrets. Fix the command. */
  usage: 2,
  /** No credentials, invalid key, or the key lacks a scope (HTTP 401/403). */
  auth: 3,
  /** The site, version or file does not exist or is not visible to this key (HTTP 404). */
  notFound: 4,
  /** Conflict: the live version moved (baseVersionId), the name is taken (HTTP 409). */
  conflict: 5,
  /** The instance refused the content: invalid input or over a limit (HTTP 400/411/413/422). */
  invalid: 6,
  /** Retryable: rate limited, server error or network failure (HTTP 429/5xx). Retry later. */
  unavailable: 7,
  /** --wait gave up before the live URL served the new version. */
  waitTimeout: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export function exitCodeForStatus(status: number): ExitCode {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  if (status === 409) return EXIT.conflict;
  if (status === 429 || status >= 500) return EXIT.unavailable;
  if (status >= 400) return EXIT.invalid;
  return EXIT.error;
}

/** An error with a stable code, a hint for the caller and the exit code to use. */
export class CliError extends DropwayError {
  readonly exitCode: ExitCode;

  constructor(opts: {
    code: string;
    message: string;
    hint?: string;
    exitCode: ExitCode;
    status?: number;
    requestId?: string;
    details?: Record<string, unknown>;
  }) {
    super({ ...opts, retryable: opts.exitCode === EXIT.unavailable });
    this.name = "CliError";
    this.exitCode = opts.exitCode;
  }
}

export type {
  ApiResponse,
  ClientOptions,
  FetchLike,
  OperationMeta,
  RequestOptions,
} from "@dropway/client";
export type { BytesResult, CallOptions };

export { movedTo };

/** Normalise an instance URL, throwing a CliError (exit 2) for bad input. */
export function normaliseApi(input: string): string {
  try {
    return sdkNormaliseApi(input);
  } catch (e) {
    if (e instanceof DropwayError) throw toCliError(e, EXIT.usage);
    throw e;
  }
}

function exitCodeFor(error: DropwayError, fallback: ExitCode): ExitCode {
  if (error.status !== undefined) return exitCodeForStatus(error.status);
  if (error.code === "network_error") return EXIT.unavailable;
  return fallback;
}

function toCliError(error: DropwayError, fallback: ExitCode = EXIT.error): CliError {
  if (error instanceof CliError) return error;
  return new CliError({
    code: error.code,
    message: error.message,
    hint: error.hint,
    details: error.details,
    status: error.status,
    requestId: error.requestId,
    exitCode: exitCodeFor(error, fallback),
  });
}

/** Turn an error response into a CliError with the exit code for its status. */
export async function errorFromResponse(res: Response): Promise<CliError> {
  return toCliError(await sdkErrorFromResponse(res));
}

export class DropwayClient extends SdkDropwayClient {
  constructor(opts: ClientOptions) {
    super({ ...opts, api: normaliseApi(opts.api), client: opts.client ?? `kofra-cli/${VERSION}` });
  }

  override async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    try {
      return await super.request<T>(method, path, opts);
    } catch (e) {
      if (e instanceof DropwayError) throw toCliError(e);
      throw e;
    }
  }

  override async requestBytes(method: string, path: string, opts: RequestOptions = {}): Promise<BytesResult> {
    try {
      return await super.requestBytes(method, path, opts);
    } catch (e) {
      if (e instanceof DropwayError) throw toCliError(e);
      throw e;
    }
  }

  // The typed methods validate synchronously (missing path parameters) before
  // reaching request(), so they need the same translation as the transport.
  override async call<I, O>(
    op: OperationMeta,
    input: I,
    opts: CallOptions = {},
  ): Promise<O> {
    try {
      return await super.call<I, O>(op, input, opts);
    } catch (e) {
      if (e instanceof DropwayError) throw toCliError(e);
      throw e;
    }
  }

  override async callBytes(
    op: OperationMeta,
    input: Record<string, unknown>,
    opts: CallOptions = {},
  ): Promise<BytesResult> {
    try {
      return await super.callBytes(op, input, opts);
    } catch (e) {
      if (e instanceof DropwayError) throw toCliError(e);
      throw e;
    }
  }

  override async callRaw<I, O>(
    op: OperationMeta,
    input: I,
    body: Uint8Array | ArrayBuffer | Blob | string,
    opts: CallOptions = {},
  ): Promise<O> {
    try {
      return await super.callRaw<I, O>(op, input, body, opts);
    } catch (e) {
      if (e instanceof DropwayError) throw toCliError(e);
      throw e;
    }
  }
}
