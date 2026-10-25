import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { cloneRawRequest } from "hono/request";
import { ApiError, appOrigin, badRequest } from "@dropway/core";
import { withLegacyHeaderNames } from "../legacy-brand";
import type { DropwayEnv } from "../env";

/** Bound wire bytes before decoding or parsing an object body. Raw uploads use their own reader. */
export async function readJson(c: Context<DropwayEnv>, maxBytes = 8 * 1024 * 1024): Promise<Record<string, unknown>> {
  const tooLarge = () => new ApiError(413, "request_too_large", `JSON requests accept up to ${maxBytes} bytes.`, "Split the request or use sha256 upload links for file bytes.", { limit: maxBytes });
  if (Number(c.req.header("content-length")) > maxBytes) {
    if (!c.req.raw.body?.locked) await c.req.raw.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const cached = Object.keys(c.req.bodyCache).length > 0;
  // Middleware may already have consumed the stream through Hono's cached readers.
  // Only reconstruct cached bodies: cloning an unread stream would tee past the cap.
  const body = cached ? (await cloneRawRequest(c.req)).body : c.req.raw.body;
  let text = "";
  if (body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  // Hono stores promises in its runtime body cache; preserve reads after next() too.
  if (!cached) Object.assign(c.req.bodyCache, { text: Promise.resolve(text) });
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw badRequest("invalid_json", "The request body must be a JSON object.", "Send Content-Type: application/json with an object body.");
}

export function apiErrorResponse(c: Context<DropwayEnv>, err: unknown): Response {
  const requestId = c.get("requestId");
  c.header("X-Request-Id", requestId);
  if (err instanceof ApiError) {
    const body = err.toJSON(requestId, appOrigin(c.get("dw")));
    if (err.status === 429 || err.status === 503) c.header("Retry-After", String(body.error.retryAfterSeconds));
    return c.json(body, err.status as 400);
  }
  console.error(
    JSON.stringify({
      event: "api_error",
      requestId,
      path: c.req.path,
      error: String(err),
      stack: (err as Error)?.stack,
    }),
  );
  return c.json(
    new ApiError(500, "internal_error", "Something went wrong on our side.", "Retry the request; if it keeps failing, report the requestId.").toJSON(requestId, appOrigin(c.get("dw"))),
    500,
  );
}

/** CORS, principal resolution, error shaping, then extension middleware. */
export function installApiMiddleware(api: Hono<DropwayEnv>, middleware: MiddlewareHandler<DropwayEnv>[]) {
  api.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: withLegacyHeaderNames(["Authorization", "Content-Type", "X-Kofra-Path", "X-Kofra-Client", "If-None-Match", "Idempotency-Key"]),
      allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: withLegacyHeaderNames(["ETag", "X-Request-Id", "X-Kofra-Version", "X-Kofra-Content-Type", "Retry-After"]),
      maxAge: 86400,
    }),
  );
  api.use("*", async (c, next) => {
    const dw = c.get("dw");
    c.set("principal", await dw.adapters.identity.resolve(c.req.raw, dw));
    await next();
    c.header("X-Request-Id", c.get("requestId"));
  });
  for (const mw of middleware) api.use("*", mw);
  api.onError((err, c) => apiErrorResponse(c, err));
}
