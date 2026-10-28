import type { Limits } from "../config";
import type { DropwayContext } from "../context";
import { appOrigin, siteUrl } from "../context";
import { ApiError, badRequest, forbidden, notFound, tooLarge } from "../errors";
import { SHA256_RE, sha256Hex } from "../lib/crypto";
import { normaliseContentType } from "../lib/mime";
import { stringField } from "../lib/input";
import { normaliseFilePath } from "../lib/paths";
import type { Principal } from "../principal";
import { blobScope, putVerifiedBlob } from "./blobs";
import { createDeploy, deployWarnings, finalizeDeploy, parseDeployOptions, versionConflict, type Warning } from "./deploys";
import { discardNewSite, findSite, getVersion, serializeSite, serializeVersion, type SiteRow, type VersionRow } from "./sites";
import { resolvePublishTarget } from "./publish";
import { getSiteByRef, resolveSiteSlug, resolveVersionRef } from "./site-ops";
import { PENDING_VERSION_TTL_MS } from "./upload-tokens";
import { versionPreviewUrl } from "./previews";
export { PENDING_VERSION_TTL_MS } from "./upload-tokens";
import { uploadItemsFor, type UploadItem } from "./uploads";
export type { UploadItem } from "./uploads";

/**
 * File sources for agents (SPEC 9.2 FileInput): each file names exactly one of
 * - `content` (+ `encoding: "utf8" | "base64"`): bytes inline in the call;
 * - `url` (+ optional `headers`): the server fetches it (https, public hosts only);
 * - `sha256` (+ `size`): bytes already stored, or uploaded afterwards with PUT /api/v1/blobs/{sha256};
 * - `copyFrom: { site?, version?, path? }`: a file of a site version the caller can read.
 *
 * publishSources() and updateSiteFiles() turn these into a version. Bytes the
 * server holds (inline, fetched, copied) are stored at once; sha256-only files
 * the server lacks come back as upload links (status "awaiting_upload").
 */

export interface FileInput {
  path: string;
  content?: string;
  encoding?: "utf8" | "base64";
  url?: string;
  headers?: Record<string, string>;
  sha256?: string;
  size?: number;
  copyFrom?: { site?: string; version?: string; path?: string };
  contentType?: string;
}

export interface ResolvedFile {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  /** Bytes the server holds for this file (inline or fetched); null for stored and copied files. */
  bytes: Uint8Array | null;
  source: "inline" | "url" | "stored" | "copy";
}

/** Inline caps per file (SPEC 9.2). Bigger files: url sources, or sha256 + upload links. */
export const INLINE_UTF8_MAX_BYTES = 1024 * 1024;
export const INLINE_BASE64_MAX_BYTES = 256 * 1024;
export const URL_FETCH_MAX_BYTES = 100 * 1024 * 1024;
export const URL_FETCH_TIMEOUT_MS = 30_000;
export const URL_FETCH_MAX_REDIRECTS = 3;
/** Each URL source is one subrequest; Workers allow 50 per request on the free plan. */
export const MAX_URL_SOURCES = 20;

type FieldProblem = { field: string; problem: string };

function invalid(fields: FieldProblem[]): ApiError {
  const first = fields[0]!;
  return badRequest(
    "invalid_request",
    fields.length === 1 ? `${first.field}: ${first.problem}` : `${fields.length} problems with the request; the first is ${first.field}: ${first.problem}`,
    "Fix every field listed in details.fields and call again. Each file needs a path and exactly one of content, url, sha256 or copyFrom.",
    { fields },
  );
}

// ---------------------------------------------------------------- URL fetching (SSRF-guarded)

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];
const BLOCKED_REQUEST_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "forwarded", "x-real-ip", "true-client-ip", "proxy-authorization"]);

function ipv4Blocked(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/**
 * Refuse URLs that could reach the operator's private network or cloud metadata.
 * Workers fetch() already goes out through Cloudflare's edge to the public internet;
 * this check is defence in depth and gives agents a clear error.
 */
export function assertPublicHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError(422, "fetch_blocked", `"${raw}" is not a valid URL.`, "Use an absolute https:// URL.");
  }
  const refuse = (why: string) => new ApiError(422, "fetch_blocked", `Refusing to fetch ${u.href}: ${why}.`, "Only public https:// URLs are fetched. Send the bytes inline (content) or upload them (sha256 + upload link) instead.");
  if (u.protocol !== "https:") throw refuse("only https URLs are allowed");
  if (u.username || u.password) throw refuse("credentials in the URL are not allowed (use headers)");
  if (u.port && u.port !== "443") throw refuse("only the default https port is allowed");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    // Only global unicast (2000::/3) without an embedded IPv4 address.
    if (!/^[23][0-9a-f]{0,3}:/.test(v6) || v6.includes(".")) throw refuse("private or special IPv6 addresses are not allowed");
    return u;
  }
  const v4 = ipv4Blocked(host);
  if (v4 === true) throw refuse("private, loopback and link-local addresses are not allowed");
  if (v4 === null) {
    if (!host.includes(".") || host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) throw refuse("internal host names are not allowed");
  }
  return u;
}

function cleanHeaders(headers: unknown, field: string, problems: FieldProblem[]): Record<string, string> | undefined {
  if (headers === undefined || headers === null) return undefined;
  if (typeof headers !== "object" || Array.isArray(headers)) {
    problems.push({ field, problem: "must be an object of header name to string value" });
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    const name = k.toLowerCase();
    if (typeof v !== "string") problems.push({ field: `${field}.${k}`, problem: "must be a string" });
    else if (BLOCKED_REQUEST_HEADERS.has(name) || name.startsWith("cf-") || name.startsWith("x-forwarded-")) problems.push({ field: `${field}.${k}`, problem: "this header cannot be set" });
    else out[k] = v;
  }
  return out;
}

/** Fetch one URL source: https only, public hosts only (re-checked on each redirect), size- and time-capped. */
export async function fetchUrlSource(
  url: string,
  opts: { headers?: Record<string, string>; maxBytes: number; timeoutMs?: number; fetcher?: typeof fetch; signal?: AbortSignal; consumeBytes?: (bytes: number) => void },
): Promise<{ bytes: Uint8Array; contentType: string | null; finalUrl: string }> {
  const doFetch = opts.fetcher ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? URL_FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  let current = assertPublicHttpsUrl(url);
  let headers = opts.headers;
  const fetchFailure = (error: unknown) => new ApiError(
    422, "fetch_failed", `Could not fetch ${current.href}: ${timeout.aborted ? "timed out" : String((error as Error)?.message ?? error)}.`,
    "Check the URL is reachable from the public internet, or send the bytes another way.",
    { url: current.href, retryable: true },
  );
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await doFetch(current.href, { headers: { "User-Agent": "Kofra-Fetch/1 (+https://github.com/TogetherWeOwn/dropway)", ...headers }, redirect: "manual", signal });
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      throw fetchFailure(e);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => {});
      if (hop >= URL_FETCH_MAX_REDIRECTS) throw new ApiError(422, "fetch_failed", `Too many redirects fetching ${url}.`, `Use the final URL (at most ${URL_FETCH_MAX_REDIRECTS} redirects are followed).`);
      const next = assertPublicHttpsUrl(new URL(res.headers.get("location")!, current).href);
      // Caller headers belong to the original origin, even if a later hop returns.
      if (next.origin !== current.origin) headers = undefined;
      current = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ApiError(422, "fetch_failed", `Fetching ${current.href} returned HTTP ${res.status}.`, res.status === 401 || res.status === 403 ? "The URL needs credentials: pass them in headers, or send the bytes another way." : "Check the URL.", {
        url: current.href,
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    const declared = Number(res.headers.get("content-length") ?? "NaN");
    const tooBig = () => tooLarge("file_too_large", `${current.href} is larger than ${opts.maxBytes} bytes.`, "Upload big files with sha256 + size and the returned upload link.", { url: current.href, limit: opts.maxBytes });
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw tooBig();
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          total += value.byteLength;
          if (total > opts.maxBytes) throw tooBig();
          opts.consumeBytes?.(value.byteLength);
          chunks.push(value);
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        if (opts.signal?.aborted) throw opts.signal.reason;
        throw e instanceof ApiError ? e : fetchFailure(e);
      } finally {
        signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { bytes, contentType: res.headers.get("content-type"), finalUrl: current.href };
  }
}

// ---------------------------------------------------------------- resolving file inputs

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The blob-dedupe scope a new or existing site of this caller uses ("t:<tenant>" or "s:<anonymous site>"). */
export function callerBlobScope(p: Principal, site: Pick<SiteRow, "id" | "tenant_id"> | null): string | null {
  if (site) return blobScope({ tenantId: site.tenant_id, siteId: site.id });
  if (p.kind === "member") return `t:${p.tenantId}`;
  if (p.kind === "claim") return `s:${p.siteId}`;
  return null;
}

async function storedSize(dc: DropwayContext, scope: string, sha: string): Promise<number | null> {
  const row = await dc.env.DB.prepare("SELECT b.size FROM blob_scopes bs JOIN blobs b ON b.sha256 = bs.sha256 WHERE bs.scope = ? AND bs.sha256 = ?")
    .bind(scope, sha)
    .first<{ size: number }>();
  return row ? row.size : null;
}

/**
 * Validate and resolve FileInput[] into manifest entries. Every structural problem
 * is reported at once in details.fields; fetch problems name the failing URL.
 */
export async function resolveFileInputs(
  dc: DropwayContext,
  p: Principal,
  inputs: unknown,
  opts: { lim: Limits; scope: string | null; site: SiteRow | null; field?: string; allowEmpty?: boolean; fetcher?: typeof fetch },
): Promise<{ files: ResolvedFile[]; fetched: number }> {
  const field = opts.field ?? "files";
  if (inputs === undefined || inputs === null) {
    if (opts.allowEmpty) return { files: [], fetched: 0 };
    throw invalid([{ field, problem: "is required: a non-empty array of files" }]);
  }
  if (!Array.isArray(inputs) || (!inputs.length && !opts.allowEmpty)) throw invalid([{ field, problem: "must be a non-empty array of files" }]);
  if (inputs.length > opts.lim.maxFiles) {
    throw badRequest("too_many_files", `A version can have at most ${opts.lim.maxFiles} files.`, "Split the content across sites or trim build output. Never drop files silently.", { limit: opts.lim.maxFiles });
  }
  const problems: FieldProblem[] = [];
  const seen = new Set<string>();
  type Plan =
    | { kind: "inline"; path: string; bytes: Uint8Array; contentType?: string }
    | { kind: "url"; path: string; url: string; headers?: Record<string, string>; contentType?: string }
    | { kind: "stored"; path: string; sha256: string; size: number | null; contentType?: string }
    | { kind: "copy"; path: string; from: { site?: string; version?: string; path?: string }; contentType?: string };
  const plans: Plan[] = [];
  let urlCount = 0;
  let inlineUtf8Bytes = 0;
  let inlineBase64Bytes = 0;

  inputs.forEach((raw, i) => {
    const f = `${field}[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push({ field: f, problem: "must be an object with a path and one source" });
      return;
    }
    const r = raw as Record<string, unknown>;
    const rawPath = stringField(r.path ?? "", `${field}.${i}.path`);
    let path: string;
    try {
      path = normaliseFilePath(rawPath);
    } catch (e) {
      problems.push({ field: `${f}.path`, problem: (e as ApiError).message });
      return;
    }
    if (path.startsWith("__dropway/")) problems.push({ field: `${f}.path`, problem: "paths under __dropway/ are reserved" });
    if (seen.has(path)) problems.push({ field: `${f}.path`, problem: `"${path}" appears more than once` });
    seen.add(path);
    const contentType = r.contentType == null ? undefined : stringField(r.contentType, `${field}.${i}.contentType`);
    const sources = (["content", "url", "sha256", "copyFrom"] as const).filter((k) => r[k] !== undefined && r[k] !== null);
    if (sources.length !== 1) {
      problems.push({ field: f, problem: sources.length ? `has ${sources.join(" and ")}; give exactly one source` : "needs one source: content, url, sha256 or copyFrom" });
      return;
    }
    const src = sources[0]!;
    if (src === "content") {
      if (typeof r.content !== "string") return void problems.push({ field: `${f}.content`, problem: "must be a string" });
      const enc = r.encoding ?? "utf8";
      if (enc !== "utf8" && enc !== "base64") return void problems.push({ field: `${f}.encoding`, problem: 'must be "utf8" or "base64"' });
      const bytes = enc === "base64" ? decodeBase64(r.content) : new TextEncoder().encode(r.content);
      if (!bytes) return void problems.push({ field: `${f}.content`, problem: "is not valid base64" });
      const cap = enc === "base64" ? INLINE_BASE64_MAX_BYTES : INLINE_UTF8_MAX_BYTES;
      if (enc === "base64") inlineBase64Bytes += bytes.length;
      else inlineUtf8Bytes += bytes.length;
      if (bytes.length > cap || inlineUtf8Bytes > 4 * INLINE_UTF8_MAX_BYTES || inlineBase64Bytes > 4 * INLINE_BASE64_MAX_BYTES) {
        throw tooLarge(
          "inline_too_large",
          `Inline ${enc} content exceeds ${cap} bytes per file or ${4 * cap} bytes per call.`,
          "Use the CLI (npx kofra publish <dir>), a url source, or sha256 + size with the returned upload links.",
          { path, size: bytes.length, limit: cap },
        );
      }
      plans.push({ kind: "inline", path, bytes, contentType });
    } else if (src === "url") {
      if (typeof r.url !== "string") return void problems.push({ field: `${f}.url`, problem: "must be a string" });
      const headers = cleanHeaders(r.headers, `${f}.headers`, problems);
      urlCount++;
      plans.push({ kind: "url", path, url: r.url, headers, contentType });
    } else if (src === "sha256") {
      let sha = "";
      try { sha = String(r.sha256).toLowerCase(); } catch { /* validated below */ }
      if (!SHA256_RE.test(sha)) problems.push({ field: `${f}.sha256`, problem: "must be 64 lowercase hex characters (sha256sum <file>)" });
      let size: number | null = null;
      if (r.size !== undefined && r.size !== null) {
        size = NaN;
        try { size = Number(r.size); } catch { /* validated below */ }
        if (!Number.isInteger(size) || size < 0) problems.push({ field: `${f}.size`, problem: "must be a non-negative integer (bytes)" });
      }
      plans.push({ kind: "stored", path, sha256: sha, size, contentType });
    } else {
      const c = r.copyFrom;
      if (!c || typeof c !== "object" || Array.isArray(c)) return void problems.push({ field: `${f}.copyFrom`, problem: "must be an object { site?, version?, path? }" });
      const cf = c as Record<string, unknown>;
      const from: { site?: string; version?: string; path?: string } = {};
      for (const name of ["site", "version", "path"] as const) {
        if (cf[name] == null) continue;
        try { from[name] = String(cf[name]); }
        catch { problems.push({ field: `${f}.copyFrom.${name}`, problem: "must be convertible to a string" }); }
      }
      plans.push({ kind: "copy", path, from, contentType });
    }
  });
  if (urlCount > MAX_URL_SOURCES) problems.push({ field, problem: `has ${urlCount} url sources; at most ${MAX_URL_SOURCES} per call` });
  if (problems.length) throw invalid(problems);
  if (plans.some((x) => x.kind === "stored" || x.kind === "copy") && !opts.scope) {
    throw forbidden("sha256 and copyFrom sources need an API key.", "Send the bytes inline (content) or as a url.");
  }

  const versionCache = new Map<string, Promise<{ site: SiteRow; version: VersionRow }>>();
  const sourceVersion = (siteRef: string | undefined, versionRef: string | undefined) => {
    const k = `${siteRef ?? ""}\u0000${versionRef ?? ""}`;
    let hit = versionCache.get(k);
    if (!hit) {
      hit = (async () => {
        const site = siteRef ? await getSiteByRef(dc, p, siteRef, "sites:read") : opts.site;
        if (!site) throw badRequest("invalid_request", "copyFrom needs a site when the target site does not exist yet.", "Set copyFrom.site.", { fields: [{ field: `${field}[].copyFrom.site`, problem: "is required here" }] });
        return { site, version: await resolveVersionRef(dc, site, versionRef ?? "live") };
      })();
      versionCache.set(k, hit);
    }
    return hit;
  };

  let fetchedBytes = 0;
  const acquisition = new AbortController();
  const consumeBytes = (bytes: number) => {
    acquisition.signal.throwIfAborted();
    fetchedBytes += bytes;
    if (fetchedBytes > opts.lim.oneShotMaxBytes) {
      const error = tooLarge("request_too_large", `URL sources in one call may total ${opts.lim.oneShotMaxBytes} bytes.`, "Split the files across several update_site_files calls.", { limit: opts.lim.oneShotMaxBytes });
      acquisition.abort(error);
      throw error;
    }
  };
  const out: ResolvedFile[] = new Array(plans.length);
  const queue = plans.map((plan, i) => ({ plan, i }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      acquisition.signal.throwIfAborted();
      const { plan, i } = job;
      if (plan.kind === "inline") {
        out[i] = { path: plan.path, size: plan.bytes.length, sha256: await sha256Hex(plan.bytes), contentType: normaliseContentType(plan.contentType, plan.path), bytes: plan.bytes, source: "inline" };
      } else if (plan.kind === "url") {
        const got = await fetchUrlSource(plan.url, {
          headers: plan.headers, maxBytes: Math.min(opts.lim.maxFileBytes, dc.config.urlFetchMaxBytes), fetcher: opts.fetcher,
          signal: acquisition.signal, consumeBytes,
        });
        out[i] = {
          path: plan.path,
          size: got.bytes.length,
          sha256: await sha256Hex(got.bytes),
          contentType: normaliseContentType(plan.contentType ?? got.contentType, plan.path),
          bytes: got.bytes,
          source: "url",
        };
      } else if (plan.kind === "stored") {
        const size = plan.size ?? (await storedSize(dc, opts.scope!, plan.sha256));
        if (size === null) {
          throw badRequest("invalid_request", `files: "${plan.path}" has a sha256 this owner has not stored yet, so its size is needed.`, "Add size (bytes) so the upload link can be issued.", {
            fields: [{ field: `${field}[${i}].size`, problem: "is required when the bytes are not stored yet" }],
          });
        }
        out[i] = { path: plan.path, size, sha256: plan.sha256, contentType: normaliseContentType(plan.contentType, plan.path), bytes: null, source: "stored" };
      } else {
        const { site, version } = await sourceVersion(plan.from.site, plan.from.version);
        const fromPath = normaliseFilePath(plan.from.path ?? plan.path);
        const row = await dc.env.DB.prepare("SELECT sha256, size, content_type FROM version_files WHERE version_id = ? AND path = ?")
          .bind(version.id, fromPath)
          .first<{ sha256: string; size: number; content_type: string }>();
        if (!row) throw notFound("file_not_found", `copyFrom: no file "${fromPath}" in ${site.slug} v${version.number}.`, "List files with list_files.");
        if (callerBlobScope(p, site) !== opts.scope) throw forbidden("copyFrom can only copy between sites of the same owner.");
        out[i] = { path: plan.path, size: row.size, sha256: row.sha256, contentType: plan.contentType ? normaliseContentType(plan.contentType, plan.path) : row.content_type, bytes: null, source: "copy" };
      }
    }
  };
  const workers = Array.from({ length: Math.min(4, Math.max(1, plans.length)) }, () => worker().catch((error) => {
    acquisition.abort(error);
    throw error;
  }));
  try {
    await Promise.all(workers);
  } catch (error) {
    await Promise.allSettled(workers);
    throw error;
  }
  for (const f of out) {
    if (f.size > opts.lim.maxFileBytes) {
      throw tooLarge("file_too_large", `"${f.path}" is ${f.size} bytes; the per-file limit is ${opts.lim.maxFileBytes}.`, "Compress or split the file.", { path: f.path, size: f.size, limit: opts.lim.maxFileBytes });
    }
  }
  return { files: out, fetched: plans.filter((x) => x.kind === "url").length };
}

// ---------------------------------------------------------------- results

export type PublishStatus = "live" | "unchanged" | "awaiting_upload";

export interface NextStep {
  tool: string;
  args?: Record<string, unknown>;
  why: string;
}

async function loadSite(dc: DropwayContext, id: string): Promise<SiteRow> {
  return (await dc.env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(id).first<SiteRow>())!;
}

/**
 * Store the bytes the server holds, then finalize, or report what still needs uploading.
 * Shared by publishSources and updateSiteFiles.
 */
async function completeVersion(
  dc: DropwayContext,
  actor: Principal,
  site: SiteRow,
  deploy: Awaited<ReturnType<typeof createDeploy>>,
  files: ResolvedFile[],
  counters: { fetched: number },
) {
  const manifest = files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, contentType: f.contentType }));
  const uniqueShas = new Set(files.map((f) => f.sha256));
  let status: PublishStatus;
  let stored = 0;
  let pendingShas: string[] = [];
  let warnings: Warning[] = [];
  let version: VersionRow | null;
  if (deploy.unchanged) {
    status = "unchanged";
    version = site.current_version_id ? await getVersion(dc, site.id, site.current_version_id) : null;
    warnings = await deployWarnings(dc, site, deploy.deploy.id);
  } else {
    const missing = new Set(deploy.missing);
    const scope = blobScope({ tenantId: site.tenant_id, siteId: site.id });
    const toStore = new Map<string, ResolvedFile>();
    for (const f of files) if (f.bytes && missing.has(f.sha256) && !toStore.has(f.sha256)) toStore.set(f.sha256, f);
    const queue = [...toStore.values()];
    await Promise.all(
      Array.from({ length: Math.min(6, queue.length) }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) await putVerifiedBlob(dc, scope, f.sha256, f.bytes!, f.size, f.contentType);
      }),
    );
    stored = toStore.size;
    pendingShas = [...missing].filter((s) => !toStore.has(s));
    if (pendingShas.length) {
      status = "awaiting_upload";
      version = await getVersion(dc, site.id, deploy.deploy.id);
    } else {
      const result = await finalizeDeploy(dc, actor, site, deploy.deploy.id);
      status = "live";
      warnings = result.warnings;
      version = result.version;
    }
  }
  const fresh = await loadSite(dc, site.id);
  const live = fresh.current_version_id ? await getVersion(dc, fresh.id, fresh.current_version_id) : null;
  const versionOut = version ? serializeVersion(version, fresh.current_version_id) : null;
  const next: NextStep[] = [];
  let upload: { versionId: string; expiresAt: string; items: UploadItem[]; finalize: NextStep } | undefined;
  if (status === "awaiting_upload" && version) {
    const finalize: NextStep = {
      tool: "finalize_version",
      args: { site: fresh.slug, versionId: version.id },
      why: `first PUT the raw bytes of the ${pendingShas.length} file(s) in upload.items to their url (same Authorization header; each item has a ready curl line), then call this to go live`,
    };
    upload = {
      versionId: version.id,
      expiresAt: new Date(version.created_at + PENDING_VERSION_TTL_MS).toISOString(),
      items: await uploadItemsFor(dc, version, manifest, pendingShas),
      finalize,
    };
    next.push(finalize);
  } else if (versionOut) {
    next.push({ tool: "update_site_files", args: { site: fresh.slug, baseVersionId: fresh.current_version_id }, why: "change a few files later without re-sending the rest" });
  }
  return {
    status,
    unchanged: status === "unchanged",
    url: siteUrl(dc, fresh.slug),
    versionUrl: await versionPreviewUrl(dc, actor, fresh, version!),
    slug: fresh.slug,
    site: { id: fresh.id, ...serializeSite(dc, fresh, live) },
    version: versionOut,
    files: {
      total: files.length,
      stored,
      reused: status === "unchanged" ? uniqueShas.size : uniqueShas.size - stored - pendingShas.length,
      fetched: counters.fetched,
      pending: pendingShas.length,
    },
    ...(upload ? { upload } : {}),
    warnings,
    next,
  };
}

// ---------------------------------------------------------------- publish

export interface PublishSourcesInput {
  files: unknown;
  /** Existing site to replace (slug, id or URL), or the slug for a new site. Omit for a generated name. */
  site?: unknown;
  /** Legacy REST JSON alias for a site slug. */
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  spa?: unknown;
  renderMarkdown?: unknown;
  crossOriginIsolation?: unknown;
  password?: unknown;
  message?: unknown;
  baseVersionId?: unknown;
  /** Attribution stored on the version, e.g. "claude-code/2.1". */
  client?: string | null;
  /** How the version was made ("mcp", "api"...). */
  source?: string;
  fetcher?: typeof fetch;
}

/**
 * Publish a whole site from file sources: creates the site (or replaces all files
 * of an existing one) and makes the new version live, unless some sha256-only
 * files still need uploading (status "awaiting_upload" with upload links).
 */
export async function publishSources(dc: DropwayContext, p: Principal, input: PublishSourcesInput) {
  const metadata = parseDeployOptions({ message: input.message, baseVersionId: input.baseVersionId });
  const tenantId = p.kind === "member" ? p.tenantId : null;
  const siteRef = input.site ?? (input.slug == null ? undefined : stringField(input.slug, "slug"));
  const slug = siteRef === undefined || siteRef === null || siteRef === "" ? null : await resolveSiteSlug(dc, siteRef);
  // Resolve sources before creating anything, so a bad URL never leaves an empty site behind.
  let existing: SiteRow | null = null;
  if (p.kind === "claim") existing = await dc.env.DB.prepare("SELECT * FROM sites WHERE id = ? AND deleted_at IS NULL").bind(p.siteId).first<SiteRow>();
  else if (slug && p.kind === "member") {
    const found = await findSite(dc, slug);
    if (found && found.tenant_id === p.tenantId) existing = found;
  }
  const lim = await dc.adapters.policy.limits(p, { siteId: existing?.id ?? null, tenantId: existing ? existing.tenant_id : tenantId }, dc);
  const resolved = await resolveFileInputs(dc, p, input.files, { lim, scope: callerBlobScope(p, existing), site: existing, fetcher: input.fetcher });

  const fields: Record<string, unknown> = { slug };
  for (const k of ["title", "description", "spa", "renderMarkdown", "crossOriginIsolation", "password"] as const) if (input[k] !== undefined) fields[k] = input[k];
  const manifest = resolved.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, contentType: f.contentType }));
  const target = await resolvePublishTarget(dc, p, fields, manifest);
  const site = target.site;
  const actor: Principal = target.claimToken ? { kind: "claim", siteId: site.id, ip: p.ip } : p;
  let out: Awaited<ReturnType<typeof completeVersion>>;
  try {
    const deploy = await createDeploy(dc, actor, site, manifest, { ...metadata, source: input.source ?? "mcp", client: input.client ?? null });
    out = await completeVersion(dc, actor, site, deploy, resolved.files, { fetched: resolved.fetched });
  } catch (e) {
    // A site created by this call is removed again, so a failed publish leaves nothing behind.
    if (target.created) await discardNewSite(dc, site);
    throw e;
  }
  return {
    ...out,
    created: target.created,
    ...(target.claimToken
      ? {
          // Retain the original JSON publish credential fields during the v2 transition.
          claimToken: target.claimToken,
          claimUrl: `${appOrigin(dc)}/claim?slug=${site.slug}#token=${target.claimToken}`,
          expiresAt: site.expires_at ? new Date(site.expires_at).toISOString() : null,
          claim: {
            url: `${appOrigin(dc)}/claim?slug=${site.slug}#token=${target.claimToken}`,
            token: target.claimToken,
            expiresAt: site.expires_at ? new Date(site.expires_at).toISOString() : null,
            note: "Anonymous sites expire. Keep the token: it is shown once. Use it as a Bearer token to update this site, or claim the site with an API key (claim_site).",
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------- partial updates

export interface UpdateSiteFilesInput {
  /** Files to add or replace (FileInput[]). */
  files?: unknown;
  /** Paths to delete; a trailing "/" deletes a whole folder. */
  delete?: unknown;
  /** Renames: [{ from, to }]. */
  move?: unknown;
  /** Version the change is based on ("live", "v3", id). Defaults to the live version. */
  baseVersionId?: unknown;
  message?: unknown;
  client?: string | null;
  source?: string;
  fetcher?: typeof fetch;
}

/**
 * Change some files of a site: everything not mentioned carries over from the base
 * version by hash, so nothing is re-sent. If someone published since the base
 * version, this fails with 409 version_conflict instead of overwriting their work.
 */
export async function updateSiteFiles(dc: DropwayContext, p: Principal, siteRef: unknown, input: UpdateSiteFilesInput) {
  const site = await getSiteByRef(dc, p, siteRef, "sites:write");
  let base: VersionRow | null = null;
  if (input.baseVersionId !== undefined && input.baseVersionId !== null && input.baseVersionId !== "") {
    base = await resolveVersionRef(dc, site, stringField(input.baseVersionId, "baseVersionId"));
    if (base.id !== site.current_version_id) {
      throw await versionConflict(dc, site, base);
    }
  } else if (site.current_version_id) {
    base = await getVersion(dc, site.id, site.current_version_id);
  }

  const problems: FieldProblem[] = [];
  const deletes: string[] = [];
  if (input.delete !== undefined && input.delete !== null) {
    if (!Array.isArray(input.delete)) problems.push({ field: "delete", problem: "must be an array of paths" });
    else
      input.delete.forEach((d, i) => {
        if (typeof d !== "string" || !d.trim()) return void problems.push({ field: `delete[${i}]`, problem: "must be a non-empty path" });
        try {
          deletes.push(d.trim().endsWith("/") ? `${normaliseFilePath(d)}/` : normaliseFilePath(d));
        } catch (e) {
          problems.push({ field: `delete[${i}]`, problem: (e as ApiError).message });
        }
      });
  }
  const moves: Array<{ from: string; to: string }> = [];
  if (input.move !== undefined && input.move !== null) {
    if (!Array.isArray(input.move)) problems.push({ field: "move", problem: "must be an array of { from, to }" });
    else
      input.move.forEach((m, i) => {
        const r = (m ?? {}) as Record<string, unknown>;
        try {
          moves.push({ from: normaliseFilePath(String(r.from ?? "")), to: normaliseFilePath(String(r.to ?? "")) });
        } catch (e) {
          problems.push({ field: `move[${i}]`, problem: (e as ApiError).message });
        }
      });
  }
  const hasWrites = Array.isArray(input.files) && input.files.length > 0;
  if (!problems.length && !hasWrites && !deletes.length && !moves.length) {
    problems.push({ field: "files", problem: "nothing to change: give files to write, paths to delete, or moves" });
  }
  if (problems.length) throw invalid(problems);

  const tree = new Map<string, { sha256: string; size: number; contentType: string }>();
  if (base) {
    const { results } = await dc.env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ?")
      .bind(base.id)
      .all<{ path: string; sha256: string; size: number; content_type: string }>();
    for (const r of results) tree.set(r.path, { sha256: r.sha256, size: r.size, contentType: r.content_type });
  }
  const warnings: Warning[] = [];
  const deleted: string[] = [];
  for (const d of deletes) {
    const matched = d.endsWith("/") ? [...tree.keys()].filter((k) => k.startsWith(d)) : tree.has(d) ? [d] : [];
    if (!matched.length) warnings.push({ code: "delete_missing", message: `Nothing to delete at "${d}" (already gone).` });
    for (const k of matched) {
      tree.delete(k);
      deleted.push(k);
    }
  }
  for (const m of moves) {
    const f = tree.get(m.from);
    if (!f) throw notFound("file_not_found", `move: no file "${m.from}" in the base version.`, "List files with list_files.");
    tree.delete(m.from);
    tree.set(m.to, f);
  }
  const lim = await dc.adapters.policy.limits(p, { siteId: site.id, tenantId: site.tenant_id }, dc);
  const resolved = await resolveFileInputs(dc, p, input.files, { lim, scope: callerBlobScope(p, site), site, allowEmpty: true, fetcher: input.fetcher });
  let written = 0;
  for (const f of resolved.files) {
    const prev = tree.get(f.path);
    if (!prev || prev.sha256 !== f.sha256 || prev.contentType !== f.contentType) written++;
    tree.set(f.path, { sha256: f.sha256, size: f.size, contentType: f.contentType });
  }
  if (tree.size === 0) {
    throw badRequest("files_required", "This change would leave the site with no files.", "Keep at least one file, or delete the whole site with delete_site.");
  }
  const byPath = new Map(resolved.files.map((f) => [f.path, f]));
  const all: ResolvedFile[] = [...tree.entries()].map(([path, f]) => byPath.get(path) ?? { path, size: f.size, sha256: f.sha256, contentType: f.contentType, bytes: null, source: "copy" });
  const deploy = await createDeploy(dc, p, site, all.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, contentType: f.contentType })), {
    source: input.source ?? "mcp",
    message: input.message,
    client: input.client ?? null,
    baseVersionId: base?.id ?? null,
  });
  const out = await completeVersion(dc, p, site, deploy, all, { fetched: resolved.fetched });
  return {
    ...out,
    warnings: [...warnings, ...out.warnings],
    changes: { written, deleted, moved: moves, carriedOver: all.length - resolved.files.length, baseVersionId: base?.id ?? null },
  };
}

/**
 * Make a pending version live once its uploads are done. Safe to repeat. When bytes
 * are still missing, the 409 missing_blobs error carries fresh upload items.
 */
export async function finalizeVersionByRef(dc: DropwayContext, p: Principal, siteRef: unknown, versionRef: unknown) {
  const site = await getSiteByRef(dc, p, siteRef, "sites:write");
  const version = await resolveVersionRef(dc, site, versionRef);
  try {
    const result = await finalizeDeploy(dc, p, site, version.id);
    const fresh = await loadSite(dc, site.id);
    const live = fresh.current_version_id ? await getVersion(dc, fresh.id, fresh.current_version_id) : null;
    return {
      status: (result.live ? "live" : "unchanged") as PublishStatus,
      replayed: result.replayed,
      url: siteUrl(dc, fresh.slug),
      versionUrl: await versionPreviewUrl(dc, p, fresh, result.version),
      slug: fresh.slug,
      site: { id: fresh.id, ...serializeSite(dc, fresh, live) },
      version: serializeVersion(result.version, fresh.current_version_id),
      warnings: result.warnings,
      next: [] as NextStep[],
    };
  } catch (e) {
    if (e instanceof ApiError && e.code === "missing_blobs") {
      const missing = new Set(((e.details?.missing as string[] | undefined) ?? []).map(String));
      const { results } = await dc.env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ?")
        .bind(version.id)
        .all<{ path: string; sha256: string; size: number; content_type: string }>();
      const items = await uploadItemsFor(dc, version, results.map((r) => ({ path: r.path, sha256: r.sha256, size: r.size, contentType: r.content_type })), missing);
      throw new ApiError(409, "missing_blobs", e.message, "PUT the raw bytes of each item in details.uploads to its url (same Authorization header), then call finalize_version again.", {
        missing: [...missing],
        uploads: items,
        upload: { versionId: version.id, expiresAt: new Date(version.created_at + PENDING_VERSION_TTL_MS).toISOString(), items },
        ...(e.details?.totalMissing !== undefined ? { totalMissing: e.details.totalMissing } : {}),
      });
    }
    throw e;
  }
}
