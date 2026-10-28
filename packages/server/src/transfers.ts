import {
  ApiError, appOrigin, checkTransferGate, describeTransfer, makeTransferGrant, openTransferDownload,
  publicTransfer, transferCookieName, transferFileUrl, transferMissing, transferPageUrl, transferRecipients,
  transferUnlocked, unlockTransfer, type DropwayContext,
} from "@dropway/core";
import type { Hono } from "hono";
import type { DropwayEnv } from "./env";
import { APP_PAGE_CSP, escapeHtml, htmlPage } from "./html";
import { attachmentDisposition } from "./content-disposition";

const headers = {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": APP_PAGE_CSP, "X-Frame-Options": "DENY",
};
function page(body: string, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(htmlPage({ title: "File delivery", body: `<main class="dw-system"><h1>File delivery</h1>${body}</main>` }), {
    status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8", ...extraHeaders },
  });
}
function passwordPage(dc: DropwayContext, slug: string, recipient?: string, error?: { status: number; message: string }) {
  const alert = error ? `<p role="alert">${escapeHtml(error.message)}</p>` : "";
  return page(`<p>This delivery is password protected.</p>${alert}<form method="post" action="${escapeHtml(transferPageUrl(dc, slug, recipient))}"><label>Password <input type="password" name="password" minlength="8" maxlength="1024" required autocomplete="current-password"></label><button type="submit">Unlock delivery</button></form>`, error?.status ?? 403);
}
const HTML_UNLOCK_ERRORS: Record<string, { status: number; message: string }> = {
  transfer_locked: { status: 403, message: "Incorrect password. Try again or ask the sender for the delivery password." },
  rate_limited: { status: 429, message: "Too many password attempts. Wait a moment, then try again." },
};
export function transferPageError(dc: DropwayContext, request: Request, slug: string, recipient: string | undefined, error: unknown): Response {
  if (request.method === "POST" && (request.headers.get("Accept") ?? "").includes("text/html") && error instanceof ApiError) {
    const mapped = HTML_UNLOCK_ERRORS[error.code];
    if (mapped) {
      const res = passwordPage(dc, slug, recipient, mapped);
      if (mapped.status === 429) res.headers.set("Retry-After", String(error.details?.retryAfterSeconds ?? 60));
      return res;
    }
    if (error.code === "transfer_unlock_unavailable") {
      return page(`<p>Password unlock is unavailable. Try again later.</p><p><a href="${escapeHtml(transferPageUrl(dc, slug, recipient))}">Back to this delivery</a></p>`, 503);
    }
  }
  return transferError(error);
}
export function transferError(error: unknown): Response {
  if (!(error instanceof ApiError)) throw error;
  return Response.json(error.toJSON(), { status: error.status, headers: { ...headers, ...(error.status === 429 ? { "Retry-After": String(error.details?.retryAfterSeconds ?? 60) } : {}) } });
}
async function readPasswordForm(request: Request): Promise<string> {
  const maxBytes = 16_384;
  const tooLarge = () => new ApiError(413, "request_too_large", "Form too large.", "Send a password form of at most 16,384 bytes.");
  if (Number(request.headers.get("Content-Length")) > maxBytes) {
    await request.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const buffer = new Uint8Array(maxBytes);
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      buffer.set(value, bytes);
      bytes += value.byteLength;
    }
    return new TextDecoder().decode(buffer.subarray(0, bytes));
  } finally { reader.releaseLock(); }
}
export function installTransferPages(app: Hono<DropwayEnv>) {
  app.on(["GET", "HEAD", "POST"], "/t/:slug", async (c) => {
    const dc = c.get("dw");
    const slug = c.req.param("slug");
    const recipient = c.req.query("recipient");
    try {
      if (new URL(c.req.url).origin !== new URL(appOrigin(dc)).origin) throw transferMissing();
      const t = await publicTransfer(dc, slug);
      checkTransferGate(t);
      if (recipient && !transferRecipients(t).some((r) => r.token === recipient)) throw transferMissing();
      if (c.req.method === "POST") {
        if (c.req.header("Origin") !== appOrigin(dc) || ["cross-site", "same-site"].includes(c.req.header("Sec-Fetch-Site") ?? "")) return new Response("Origin refused", { status: 403, headers });
        const text = await readPasswordForm(c.req.raw);
        const grant = await unlockTransfer(dc, t, new URLSearchParams(text).get("password"), c.req.header("CF-Connecting-IP") ?? "unknown");
        return new Response(null, { status: 303, headers: { ...headers, Location: transferPageUrl(dc, t.slug, recipient),
          "Set-Cookie": `${transferCookieName(t)}=${grant}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900` } });
      }
      if (!await transferUnlocked(dc, t, c.req.raw)) return passwordPage(dc, t.slug, recipient);
      const description = await describeTransfer(dc, t);
      const grant = t.password_hash ? await makeTransferGrant(dc, t) : null;
      const files = description.files.map((f) => {
        const url = new URL(transferFileUrl(dc, t.slug, f.path, recipient));
        if (grant) url.searchParams.set("grant", grant);
        return `<li><a href="${escapeHtml(url.href)}" rel="noreferrer">${escapeHtml(f.path)}</a> — ${f.size} bytes, ${escapeHtml(f.contentType)}<br><code>SHA-256 ${f.sha256}</code></li>`;
      }).join("");
      const allowance = t.download_limit === null
        ? `<p>Unlimited downloads.</p>`
        : `<p>${t.downloads} of ${t.download_limit} downloads used.</p>`;
      const response = page(`<p style="white-space:pre-wrap">${escapeHtml(t.message ?? "")}</p><ul>${files}</ul><p>Kofra does not scan files. Only open files you trust from the sender.</p>${allowance}<p>Available until ${escapeHtml(new Date(t.expires_at).toISOString())}.</p>`);
      return c.req.method === "HEAD" ? new Response(null, response) : response;
    } catch (error) { return transferPageError(dc, c.req.raw, slug, recipient, error); }
  });
}

export async function serveTransfer(request: Request, dc: DropwayContext, slug: string, path: string): Promise<Response> {
  try {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    const out = await openTransferDownload(dc, request, slug, path);
    if (out.locked) {
      if ((request.headers.get("Accept") ?? "").includes("text/html")) return page(`<p><a href="${escapeHtml(transferPageUrl(dc, slug))}">Unlock this delivery</a> on the application.</p>`, 403);
      throw new ApiError(403, "transfer_locked", "Password required.", "Unlock the delivery on its app-origin page.");
    }
    const filename = out.file.path.split("/").pop()!;
    // Transfers have always sent filename*, even for ASCII names.
    const disposition = attachmentDisposition(filename, { alwaysExtended: true });
    return new Response(out.body, { status: out.ranged ? 206 : 200, headers: {
      ...headers, "Content-Type": out.file.content_type, "Content-Disposition": disposition,
      "Content-Length": String(out.length), "Accept-Ranges": "bytes",
      ...(out.continuationCookie ? { "Set-Cookie": out.continuationCookie } : {}),
      ...(out.ranged ? { "Content-Range": `bytes ${out.offset}-${out.offset + out.length - 1}/${out.file.size}` } : {}),
    } });
  } catch (error) { return transferError(error); }
}
