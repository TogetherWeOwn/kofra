/**
 * The publish protocol, independent of where the bytes come from:
 *
 *   1. (new site) POST /sites                 -> slug (+ claimToken when anonymous)
 *   2. POST /sites/:slug/deploys {files}      -> which sha256 values the instance still needs
 *   3. PUT  /blobs/:sha256 for each missing   -> in parallel, retried on 429/5xx/network errors
 *   4. POST <finalizeUrl>                     -> the new version goes live atomically
 *
 * Files are content-addressed: bytes the instance already holds for this owner
 * are never uploaded again, and a byte-identical republish creates no version.
 * Runtime-neutral (fetch only), so it is tested inside the Workers runtime.
 */
import { CliError, EXIT, type DropwayClient } from "./client.ts";
import { LEGACY_HEADER_PREFIX } from "./legacy-brand.ts";

export interface SourceFile {
  /** Site path, POSIX separators, no leading slash (e.g. "assets/app.js"). */
  path: string;
  size: number;
  /** Lowercase hex SHA-256 of the bytes. */
  sha256: string;
  /** The bytes, read lazily (only files the instance is missing are read for upload). */
  body(): Promise<Blob | Uint8Array>;
}

export interface VersionInfo {
  id: string;
  number: number;
  status?: string;
  live?: boolean;
  fileCount?: number;
  totalBytes?: number;
  message?: string | null;
  client?: string | null;
  createdAt?: string | null;
  finalizedAt?: string | null;
}

export interface Warning {
  code: string;
  message: string;
}

export interface PublishOptions {
  /** Site to update; created with this name if it does not exist. Omit for a new site with a generated name. */
  site?: string | null;
  message?: string;
  title?: string;
  spa?: boolean;
  /** Fail with version_conflict (exit 5) unless this is still the live version. */
  baseVersionId?: string;
  /** Parallel uploads. Default 6. */
  concurrency?: number;
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEvent =
  | { phase: "deploy"; files: number }
  | { phase: "upload"; done: number; total: number; bytes: number; totalBytes: number }
  | { phase: "finalize" };

export interface PublishResult {
  url: string;
  slug: string;
  /** A new site was created by this publish. */
  created: boolean;
  /** Byte-identical to the live version: nothing was uploaded and no version was created. */
  unchanged: boolean;
  version: VersionInfo | null;
  files: number;
  /** Distinct files (by content) uploaded by this publish. */
  uploaded: number;
  /** Distinct files the instance already had, so they were not uploaded. */
  reused: number;
  bytesUploaded: number;
  warnings: Warning[];
  claimToken?: string;
  claimUrl?: string;
  expiresAt?: string | null;
}

interface UploadTarget {
  sha256: string;
  size: number;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  paths?: string[];
}

interface DeployResponse {
  unchanged: boolean;
  deploy: VersionInfo & { siteSlug?: string };
  missing: string[];
  uploads: UploadTarget[];
  finalizeUrl: string | null;
}

interface SiteBody {
  slug: string;
  url: string;
  currentVersion?: VersionInfo | null;
}

const enc = encodeURIComponent;

function settingsOf(opts: PublishOptions): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  if (opts.title !== undefined) s.title = opts.title;
  if (opts.spa !== undefined) s.spa = opts.spa;
  return s;
}

/** Publish a set of files as a new version of a site (creating the site when needed). */
export async function publish(client: DropwayClient, files: SourceFile[], opts: PublishOptions = {}): Promise<PublishResult> {
  if (!files.length) {
    throw new CliError({ code: "no_files", message: "There are no files to publish.", hint: "Check the path, and .dropwayignore rules.", exitCode: EXIT.usage });
  }
  const manifest = files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
  const deployBody = {
    files: manifest,
    ...(opts.message !== undefined ? { message: opts.message } : {}),
    ...(opts.baseVersionId ? { baseVersionId: opts.baseVersionId } : {}),
    ...settingsOf(opts),
  };
  opts.onProgress?.({ phase: "deploy", files: files.length });

  let slug = opts.site ? opts.site.trim().toLowerCase() : null;
  let token = client.token;
  let created = false;
  let claim: Pick<PublishResult, "claimToken" | "claimUrl" | "expiresAt"> = {};
  let deploy: DeployResponse | null = null;

  if (slug) {
    try {
      deploy = (await client.post<DeployResponse>(`/sites/${enc(slug)}/deploys`, deployBody)).data;
    } catch (e) {
      // A named site that does not exist yet is created below (claim tokens cannot create sites).
      if (!(e instanceof CliError && e.code === "site_not_found" && !token?.startsWith("dwc_"))) throw e;
    }
  }

  if (!deploy) {
    const res = await client.post<{ site: SiteBody; claimToken?: string; claimUrl?: string; expiresAt?: string | null }>("/sites", {
      ...(slug ? { slug } : {}),
      ...settingsOf(opts),
    });
    created = true;
    slug = res.data.site.slug;
    if (res.data.claimToken) {
      token = res.data.claimToken;
      claim = { claimToken: res.data.claimToken, claimUrl: res.data.claimUrl, expiresAt: res.data.expiresAt ?? null };
    }
    try {
      deploy = (await client.post<DeployResponse>(`/sites/${enc(slug)}/deploys`, deployBody, { token })).data;
    } catch (e) {
      // Do not leave an empty site behind when the files were refused (too large, too many...).
      await client.request("DELETE", `/sites/${enc(slug)}`, { token }).catch(() => {});
      throw e;
    }
  }
  if (!slug) throw new CliError({ code: "unexpected_response", message: "The instance did not return a site name.", exitCode: EXIT.error });

  const distinct = new Set(manifest.map((f) => f.sha256)).size;

  if (deploy.unchanged) {
    const site = (await client.get<{ site: SiteBody }>(`/sites/${enc(slug)}`, { token })).data.site;
    return {
      url: site.url,
      slug,
      created,
      unchanged: true,
      version: site.currentVersion ?? deploy.deploy,
      files: files.length,
      uploaded: 0,
      reused: distinct,
      bytesUploaded: 0,
      warnings: [],
      ...claim,
    };
  }

  const bySha = new Map<string, SourceFile>();
  for (const f of files) if (!bySha.has(f.sha256)) bySha.set(f.sha256, f);
  const uploaded = new Set<string>();
  let bytesUploaded = 0;

  const upload = async (targets: UploadTarget[]) => {
    const queue = targets.filter((t) => !uploaded.has(t.sha256));
    const total = queue.length;
    const totalBytes = queue.reduce((n, t) => n + t.size, 0);
    let done = 0;
    let bytes = 0;
    opts.onProgress?.({ phase: "upload", done, total, bytes, totalBytes });
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const file = bySha.get(t.sha256);
        if (!file) {
          throw new CliError({ code: "unexpected_upload", message: `The instance asked for ${t.sha256}, which is not in this publish.`, exitCode: EXIT.error });
        }
        await client.request(t.method ?? "PUT", t.url, { body: await file.body(), headers: t.headers ?? {}, token, retry: "safe" });
        uploaded.add(t.sha256);
        done++;
        bytes += t.size;
        bytesUploaded += t.size;
        opts.onProgress?.({ phase: "upload", done, total, bytes, totalBytes });
      }
    };
    const n = Math.max(1, Math.min(opts.concurrency ?? 6, total));
    await Promise.all(Array.from({ length: n }, worker));
  };

  await upload(deploy.uploads ?? []);

  const finalizeUrl = deploy.finalizeUrl ?? `/sites/${enc(slug)}/deploys/${enc(deploy.deploy.id)}/finalize`;
  opts.onProgress?.({ phase: "finalize" });
  const finalize = () => client.post<{ url: string; site: SiteBody; warnings?: Warning[] }>(finalizeUrl, {}, { token, retry: "safe" });
  let fin;
  try {
    fin = (await finalize()).data;
  } catch (e) {
    // Another publish or the hourly cleanup can race us; upload what the instance says is missing, once.
    const missing = e instanceof CliError && e.code === "missing_blobs" ? (e.details?.missing as string[] | undefined) : undefined;
    if (!missing?.length || missing.some((s) => !bySha.has(s))) throw e;
    for (const s of missing) uploaded.delete(s);
    await upload(missing.map((sha256) => ({ sha256, size: bySha.get(sha256)!.size, url: `/blobs/${sha256}` })));
    fin = (await finalize()).data;
  }

  return {
    url: fin.url,
    slug,
    created,
    unchanged: false,
    version: fin.site?.currentVersion ?? deploy.deploy,
    files: files.length,
    uploaded: uploaded.size,
    reused: distinct - uploaded.size,
    bytesUploaded,
    warnings: fin.warnings ?? [],
    ...claim,
  };
}

/**
 * Publish a .zip in one request: the instance unpacks it (one-shot publish, up
 * to the instance's ONESHOT_MAX_BYTES, 25 MB by default).
 */
export async function publishZip(client: DropwayClient, zip: Blob | Uint8Array, opts: Pick<PublishOptions, "site" | "message" | "title" | "spa" | "baseVersionId"> = {}): Promise<PublishResult> {
  const q = new URLSearchParams();
  if (opts.site) q.set("slug", opts.site.trim().toLowerCase());
  if (opts.message !== undefined) q.set("message", opts.message);
  if (opts.title !== undefined) q.set("title", opts.title);
  if (opts.spa !== undefined) q.set("spa", String(opts.spa));
  if (opts.baseVersionId) q.set("baseVersionId", opts.baseVersionId);
  const qs = q.toString();
  const { data } = await client.request<{
    url: string;
    slug: string;
    created: boolean;
    unchanged: boolean;
    version: VersionInfo | null;
    files: string[];
    uploaded: number;
    reused: number;
    warnings?: Warning[];
    claimToken?: string;
    claimUrl?: string;
    expiresAt?: string | null;
  }>("POST", `/publish${qs ? `?${qs}` : ""}`, { body: zip, headers: { "Content-Type": "application/zip" } });
  return {
    url: data.url,
    slug: data.slug,
    created: data.created,
    unchanged: data.unchanged,
    version: data.version,
    files: Array.isArray(data.files) ? data.files.length : 0,
    uploaded: data.uploaded ?? 0,
    reused: data.reused ?? 0,
    bytesUploaded: zip instanceof Uint8Array ? zip.byteLength : zip.size,
    warnings: data.warnings ?? [],
    ...(data.claimToken ? { claimToken: data.claimToken, claimUrl: data.claimUrl, expiresAt: data.expiresAt ?? null } : {}),
  };
}

/**
 * Poll the live URL until it serves `versionId` (X-Kofra-Version), so an agent
 * can open the URL the moment the command returns. Resolves false on timeout.
 *
 * The timeout is an overall budget: in-flight fetches, body disposal and the
 * interval between polls all count against it. The outstanding fetch is aborted
 * at the deadline, no poll starts after it, and live requires a successful
 * status plus the expected version header (a body-disposal failure is never
 * live). A transport that ignores AbortSignal still cannot strand the helper:
 * the deadline race settles first.
 */
export async function waitForVersion(
  url: string,
  versionId: string,
  opts: { timeoutMs?: number; intervalMs?: number; fetch?: (req: Request) => Promise<Response> } = {},
): Promise<boolean> {
  const doFetch = opts.fetch ?? ((req: Request) => fetch(req));
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const interval = opts.intervalMs ?? 1000;
  const TIMED_OUT = Symbol("wait-timeout");
  let first = true;
  for (;;) {
    if (!first && Date.now() >= deadline) return false;
    first = false;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(TIMED_OUT);
      }, Math.max(0, deadline - Date.now()));
    });
    let res: Response;
    try {
      const req = new Request(url, {
        method: "GET",
        headers: { Accept: "*/*", "Cache-Control": "no-cache" },
        redirect: "follow",
        signal: controller.signal,
      });
      res = await Promise.race([doFetch(req), timeout]);
    } catch (e) {
      if (timer !== undefined) clearTimeout(timer);
      if (e === TIMED_OUT) return false;
      if (controller.signal.aborted || Date.now() >= deadline) return false;
      /* Network failure before the deadline: retry after the interval. */
      if (Date.now() + interval > deadline) return false;
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }
    if (timer !== undefined) clearTimeout(timer);

    try {
      const cancel = res.body && typeof (res.body as { cancel?: unknown }).cancel === "function"
        ? (res.body as unknown as { cancel: () => Promise<unknown> }).cancel.bind(res.body)
        : null;
      if (cancel) {
        let cancelTimer: ReturnType<typeof setTimeout> | undefined;
        const cancelTimeout = new Promise<never>((_, reject) => {
          cancelTimer = setTimeout(() => reject(TIMED_OUT), Math.max(0, deadline - Date.now()));
        });
        try {
          await Promise.race([cancel(), cancelTimeout]);
        } finally {
          if (cancelTimer !== undefined) clearTimeout(cancelTimer);
        }
      }
    } catch (e) {
      if (e === TIMED_OUT || Date.now() >= deadline) return false;
      /* A body that cannot be disposed is never live; retry while budget remains. */
      if (Date.now() + interval > deadline) return false;
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }

    const statusOk = typeof res.ok === "boolean" ? res.ok : res.status >= 200 && res.status < 300;
    if (statusOk && (res.headers.get("x-kofra-version") ?? res.headers.get(`${LEGACY_HEADER_PREFIX}Version`)) === versionId) return true;
    if (Date.now() + interval > deadline) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}
