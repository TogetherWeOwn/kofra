import { unzipSync } from "fflate";
import type { DropwayContext } from "../context";
import { appOrigin, siteUrl } from "../context";
import { ApiError, badRequest, forbidden, tooLarge } from "../errors";
import { sha256Hex } from "../lib/crypto";
import { stringField } from "../lib/input";
import { contentTypeFor, normaliseContentType } from "../lib/mime";
import { normaliseFilePath, stripCommonRoot } from "../lib/paths";
import type { Principal } from "../principal";
import { blobScope, putVerifiedBlob } from "./blobs";
import { createDeploy, finalizeDeploy, parseDeployOptions, precheckManifest } from "./deploys";
import { createSite, discardNewSite, findSite, getSiteFor, parseSettings, serializeSite, updateSite, type SiteRow, type VersionRow } from "./sites";

/** A file held in memory for one-shot publishing. */
export interface InlineFile {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface PublishInput {
  files: InlineFile[];
  /** Metadata: slug, title, description, spa, renderMarkdown, crossOriginIsolation, noindex, viewers, ttlSeconds, password, message, baseVersionId. */
  fields: Record<string, unknown>;
  source: string;
}

const FILE_FIELD_NAMES = new Set(["file", "files", "files[]", "upload", "uploads", "uploads[]"]);
const META_FIELDS = ["slug", "title", "description", "spa", "renderMarkdown", "crossOriginIsolation", "noindex", "viewers", "ttlSeconds", "message", "path", "filename", "password", "baseVersionId"];

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Turn a POST /api/v1/publish request into files + metadata. Accepts:
 * - multipart/form-data: each file part's field name is its path (curl -F "assets/app.js=@dist/assets/app.js"),
 *   or a generic name (file, files[]) to use the uploaded file name; a single .zip part is unpacked;
 * - application/json: {"files":[{"path","content","encoding?":"base64","contentType?"}], ...settings};
 * - a .zip body (Content-Type: application/zip);
 * - one raw file body, named by ?path=, X-Kofra-Path or Content-Disposition (default index.html / index.md).
 * Metadata may also come as query parameters.
 */
export async function parsePublishRequest(dc: DropwayContext, req: Request, maxBytes: number): Promise<PublishInput> {
  const url = new URL(req.url);
  const len = Number(req.headers.get("content-length") ?? "0");
  const hint = "Use the manifest flow for bigger sites: POST /api/v1/sites/:slug/versions, PUT /api/v1/blobs/:sha256, POST .../finalize.";
  if (len > maxBytes) throw tooLarge("request_too_large", `One-shot publish accepts up to ${maxBytes} bytes per request.`, hint, { limit: maxBytes });
  const fields: Record<string, unknown> = {};
  for (const k of META_FIELDS) {
    const v = url.searchParams.get(k);
    if (v !== null) fields[k] = v;
  }
  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
  let files: InlineFile[] = [];
  let source = "publish";

  if (ctype.startsWith("multipart/form-data")) {
    const form = await req.formData();
    for (const [name, value] of form.entries()) {
      if (typeof value === "string") {
        if (META_FIELDS.includes(name)) fields[name] = value;
        continue;
      }
      const file = value as File;
      const path = FILE_FIELD_NAMES.has(name) ? file.name : name;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (FILE_FIELD_NAMES.has(name) && isZip(bytes) && /\.zip$/i.test(file.name || "") && form.getAll(name).length === 1) {
        files.push(...unzipFiles(bytes, maxBytes));
        source = "zip";
        continue;
      }
      files.push({ path: normaliseFilePath(path || "index.html"), bytes, contentType: normaliseContentType(file.type, path || "index.html") });
    }
  } else if (ctype.startsWith("application/json")) {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      throw badRequest("invalid_json", "The request body is not valid JSON.");
    }
    for (const k of META_FIELDS) if (k in body) fields[k] = body[k];
    if (!Array.isArray(body.files)) {
      throw badRequest("files_required", "JSON publish needs a files array.", 'Send {"files":[{"path":"index.html","content":"<h1>Hi</h1>"}]} (add "encoding":"base64" for binary).');
    }
    for (const [index, raw] of (body.files as Array<Record<string, unknown>>).entries()) {
      const path = normaliseFilePath(stringField(raw?.path ?? "", `files.${index}.path`));
      if (typeof raw.content !== "string") throw badRequest("invalid_file", `files[].content for "${path}" must be a string.`, 'Use "encoding":"base64" for binary content.');
      const bytes = raw.encoding === "base64" ? base64ToBytes(raw.content, path) : new TextEncoder().encode(raw.content);
      const contentType = raw.contentType == null ? undefined : stringField(raw.contentType, `files.${index}.contentType`);
      files.push({ path, bytes, contentType: normaliseContentType(contentType, path) });
    }
  } else {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) {
      throw badRequest("empty_body", "The request body is empty.", 'Send files as multipart (-F "index.html=@index.html"), JSON, a .zip, or one raw file.');
    }
    const named = (fields.path ?? fields.filename ?? req.headers.get("x-kofra-path") ?? filenameFromDisposition(req.headers.get("content-disposition"))) as string | null;
    if (ctype.includes("zip") || (isZip(bytes) && !named)) {
      files = unzipFiles(bytes, maxBytes);
      source = "zip";
    } else {
      const path = named ? normaliseFilePath(named) : defaultNameFor(ctype);
      files.push({ path, bytes, contentType: normaliseContentType(ctype.split(";")[0] || null, path) });
    }
  }
  if (files.length === 0) throw badRequest("files_required", "No files found in the request.", 'Example: curl -F "index.html=@index.html" .../api/v1/publish');
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > maxBytes) throw tooLarge("request_too_large", `One-shot publish accepts up to ${maxBytes} bytes of files.`, hint, { limit: maxBytes });
  return { files, fields, source };
}

function base64ToBytes(b64: string, path: string): Uint8Array {
  try {
    const bin = atob(b64.replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw badRequest("invalid_base64", `files[].content for "${path}" is not valid base64.`);
  }
}

function filenameFromDisposition(cd: string | null): string | null {
  if (!cd) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ""));
    } catch {
      return null;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1]!.trim() : null;
}

function defaultNameFor(ctype: string): string {
  const t = ctype.split(";")[0]!.trim();
  if (t === "text/html" || t === "") return "index.html";
  if (t === "text/markdown" || t === "text/x-markdown") return "index.md";
  if (t === "text/plain") return "index.txt";
  throw badRequest("path_required", `Cannot pick a file name for a ${t} body.`, "Add ?path=<name.ext> (or an X-Kofra-Path header) to say what the file is called.");
}

function unzipFiles(bytes: Uint8Array, maxBytes: number): InlineFile[] {
  let total = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith("/") || f.name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(f.name)) return false;
        total += f.originalSize;
        if (total > maxBytes) throw tooLarge("zip_too_large", `The zip expands to more than ${maxBytes} bytes.`, "Use the manifest flow for bigger sites.");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw badRequest("invalid_zip", "Could not read the zip file.", "Send a standard .zip (deflate or stored).");
  }
  const files = Object.entries(entries).map(([name, data]) => ({ path: normaliseFilePath(name), bytes: data, contentType: contentTypeFor(name) }));
  const hasRootIndex = files.some((f) => /^(index\.html?|index\.md|readme\.md)$/i.test(f.path));
  return hasRootIndex ? files : stripCommonRoot(files);
}

/**
 * Which site a one-shot publish targets: the claim token's site, an existing site by slug, or a new one.
 * `manifest` (when known) is checked before a new site is created, so a refused publish creates nothing.
 */
export async function resolvePublishTarget(dc: DropwayContext, p: Principal, fields: Record<string, unknown>, manifest?: unknown) {
  const settings = parseSettings(fields);
  const slug = fields.slug ? stringField(fields.slug, "slug").trim().toLowerCase() : null;
  if (p.kind === "claim") {
    const row = await dc.env.DB.prepare("SELECT slug FROM sites WHERE id = ? AND deleted_at IS NULL").bind(p.siteId).first<{ slug: string }>();
    if (!row) throw forbidden("The site for this claim token no longer exists.");
    if (slug && slug !== row.slug) throw forbidden("A claim token can only publish to its own site.", `Omit slug, or use slug "${row.slug}".`);
    const site = await getSiteFor(dc, p, row.slug, "sites:write");
    return { site: Object.keys(settings).length ? await updateSite(dc, p, site.slug, settings) : site, claimToken: null, created: false };
  }
  if (slug && p.kind === "member") {
    const existing = await findSite(dc, slug);
    if (existing && existing.tenant_id === p.tenantId) {
      const site = await getSiteFor(dc, p, slug, "sites:write");
      return { site: Object.keys(settings).length ? await updateSite(dc, p, site.slug, settings) : site, claimToken: null, created: false };
    }
  }
  const created = await createSite(dc, p, { slug, ...settings }, {
    beforeInsert: manifest === undefined ? undefined : (owner) => precheckManifest(dc, p, owner.tenantId, manifest),
  });
  return { site: created.site, claimToken: created.claimToken, created: true };
}

/**
 * One call to a live URL: resolve or create the site, store new blobs
 * (deduplicated), record a version and make it live.
 */
export async function publishFiles(dc: DropwayContext, p: Principal, input: PublishInput, opts: { client?: string | null } = {}) {
  const metadata = parseDeployOptions({ message: input.fields.message, baseVersionId: input.fields.baseVersionId });
  input = { ...input, fields: { ...input.fields, ...metadata } };
  const hashed = await Promise.all(input.files.map(async (f) => ({ ...f, sha256: await sha256Hex(f.bytes) })));
  const manifest = hashed.map((f) => ({ path: f.path, size: f.bytes.length, sha256: f.sha256, contentType: f.contentType }));
  const target = await resolvePublishTarget(dc, p, input.fields, manifest);
  try {
    return await publishToTarget(dc, p, input, target, hashed, manifest, opts);
  } catch (e) {
    // A site created by this call is removed again, so a failed publish leaves nothing behind.
    if (target.created) await discardNewSite(dc, target.site);
    throw e;
  }
}

async function publishToTarget(
  dc: DropwayContext,
  p: Principal,
  input: PublishInput,
  target: Awaited<ReturnType<typeof resolvePublishTarget>>,
  hashed: Array<InlineFile & { sha256: string }>,
  manifest: Array<{ path: string; size: number; sha256: string; contentType: string }>,
  opts: { client?: string | null },
) {
  let site: SiteRow = target.site;
  // Claim tokens act for the new anonymous site from here on.
  const actor: Principal = target.claimToken ? { kind: "claim", siteId: site.id, ip: p.ip } : p;
  const deploy = await createDeploy(dc, actor, site, manifest, {
    source: input.source,
    message: input.fields.message,
    client: opts.client ?? null,
    baseVersionId: input.fields.baseVersionId,
  });

  let uploaded = 0;
  let warnings: Array<{ code: string; message: string }> = [];
  let versionId = deploy.deploy.id;
  if (!deploy.unchanged) {
    const missing = new Set(deploy.missing);
    const toStore = new Map<string, (typeof hashed)[number]>();
    for (const f of hashed) if (missing.has(f.sha256) && !toStore.has(f.sha256)) toStore.set(f.sha256, f);
    const queue = [...toStore.values()];
    const scope = blobScope({ tenantId: site.tenant_id, siteId: site.id });
    await Promise.all(
      Array.from({ length: Math.min(6, queue.length) }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) await putVerifiedBlob(dc, scope, f.sha256, f.bytes, f.bytes.length, f.contentType);
      }),
    );
    uploaded = toStore.size;
    const result = await finalizeDeploy(dc, actor, site, deploy.deploy.id);
    warnings = result.warnings;
    versionId = result.version.id;
  }
  site = (await dc.env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(site.id).first<SiteRow>())!;
  const version = await dc.env.DB.prepare("SELECT * FROM versions WHERE id = ?").bind(versionId).first<VersionRow>();
  const described = serializeSite(dc, site, version);
  return {
    url: siteUrl(dc, site.slug),
    slug: site.slug,
    created: target.created,
    unchanged: deploy.unchanged,
    site: described,
    version: described.currentVersion,
    files: manifest.map((f) => f.path),
    reused: new Set(manifest.map((f) => f.sha256)).size - uploaded,
    uploaded,
    warnings,
    ...(target.claimToken
      ? {
          claimToken: target.claimToken,
          claimUrl: `${appOrigin(dc)}/claim?slug=${site.slug}#token=${target.claimToken}`,
          expiresAt: site.expires_at ? new Date(site.expires_at).toISOString() : null,
          note: "Anonymous sites expire. Keep claimToken: send it as `Authorization: Bearer <claimToken>` to update this site, or POST it to /api/v1/sites/:slug/claim with an API key to keep the site.",
        }
      : {}),
  };
}
