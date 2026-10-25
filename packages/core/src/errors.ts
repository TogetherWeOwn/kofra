import { ERROR_CODES } from "./error-codes";

export interface ErrorNextCall {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export interface ApiErrorOptions {
  retryable?: boolean;
  retryAfterSeconds?: number | null;
  docs?: string;
  next?: ErrorNextCall[];
}

/** Agent-friendly errors, shared by services, REST and MCP. Codes are stable. */
export class ApiError extends Error {
  public readonly retryable: boolean;
  public readonly retryAfterSeconds: number | null;
  public readonly docs: string;
  public readonly next: ErrorNextCall[];

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly details?: Record<string, unknown>,
    options: ApiErrorOptions = {},
  ) {
    super(message);
    this.name = "ApiError";
    const defaults = Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code] : undefined;
    this.hint = hint ?? defaults?.hint;
    this.retryable = options.retryable ?? (typeof details?.retryable === "boolean" ? details.retryable : status === 429 || status === 503 || (defaults?.retryable ?? status >= 500));
    this.retryAfterSeconds = retryDelay(options.retryAfterSeconds ?? details?.retryAfterSeconds, status);
    this.docs = options.docs ?? (defaults ? `/docs/errors#${encodeURIComponent(code)}` : "/docs/errors");
    this.next = options.next ?? [];
  }

  toJSON(requestId?: string, origin?: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        retryable: this.retryable,
        retryAfterSeconds: retryDelay(this.retryAfterSeconds, this.status),
        docs: origin ? new URL(this.docs, origin).href : this.docs,
        next: this.next,
        ...(this.details ? { details: this.details } : {}),
      },
      ...(requestId ? { requestId } : {}),
    };
  }
}

/** 429/503 always carry a delta-seconds value, including when an adapter omits it. */
function retryDelay(value: unknown, status: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : status === 429 || status === 503 ? 1 : null;
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export const badRequest = (code: string, message: string, hint?: string, details?: Record<string, unknown>) =>
  new ApiError(400, code, message, hint, details);

export const unauthorized = (message = "This endpoint needs an API key.", hint?: string, code = "unauthorized") =>
  new ApiError(
    401,
    code,
    message,
    hint ?? "Send `Authorization: Bearer dw_...`. The instance owner creates keys with POST /api/v1/keys (or for a new member with POST /api/v1/members).",
  );

export const forbidden = (message: string, hint?: string, code = "forbidden") => new ApiError(403, code, message, hint);

export const notFound = (code: string, message: string, hint?: string) => new ApiError(404, code, message, hint);

export const conflict = (code: string, message: string, hint?: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, hint, details);

export const tooLarge = (code: string, message: string, hint?: string, details?: Record<string, unknown>) =>
  new ApiError(413, code, message, hint, details);

export const rateLimited = (message: string, hint: string, retryAfterSeconds: number) =>
  new ApiError(429, "rate_limited", message, hint, { retryAfterSeconds });
