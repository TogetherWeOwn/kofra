import { detectFileKind, encodePath, KIND_LABELS, type FileKind, type LiveSite } from "@dropway/core";
import { escapeHtml, formatBytes, htmlPage } from "../html";
import type { ServeMode } from "../serve";

const LISTING_CSS = `
.dw-ls{max-width:56rem;margin:0 auto;padding:2rem 1.25rem 4rem}
.dw-ls header{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:baseline;justify-content:space-between;margin:0 0 1rem}
.dw-ls h1{font-size:1.15rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;word-break:break-all;font-weight:600}
.dw-ls h1 a{color:var(--muted);text-decoration:none}.dw-ls h1 a:hover{color:var(--accent)}
.dw-ls .sum{color:var(--muted);font-size:.85rem}
.dw-ls .sum a{margin-left:.6rem}
.dw-ls .sort,.dw-ls .filter{display:flex;flex-wrap:wrap;gap:.4rem .75rem;align-items:baseline;width:100%;font-size:.85rem;color:var(--muted)}
.dw-ls .sort a,.dw-ls .filter a{padding:.25rem .4rem;border-radius:4px}
.dw-ls .sort a[aria-current],.dw-ls .filter a[aria-current]{background:var(--card);color:var(--fg);font-weight:600}
.dw-ls a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dw-ls ul{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.dw-ls li{display:grid;grid-template-columns:1fr auto auto;gap:1rem;align-items:baseline;padding:.5rem .9rem;border-top:1px solid var(--line);background:var(--card)}
.dw-ls li:first-child{border-top:0}.dw-ls li a{text-decoration:none;word-break:break-all}.dw-ls li a:hover{text-decoration:underline}
.dw-ls li span{color:var(--muted);font-size:.8rem;white-space:nowrap}
.dw-ls li .k{font:600 .65rem/1 ui-monospace,monospace;letter-spacing:.04em;text-transform:uppercase}
.dw-ls .dir a{font-weight:600}
.dw-gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(9rem,1fr));gap:.6rem;margin:1.5rem 0 0}
.dw-gal a{display:block;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--card);text-decoration:none}
.dw-gal img{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:var(--code)}
.dw-gal span{display:block;padding:.3rem .5rem;font-size:.75rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;

const GALLERY_MAX = 60;
const SORTS = [["name", "Name"], ["size", "Largest first"], ["type", "Type"]] as const;
const KINDS = Object.entries(KIND_LABELS) as Array<[FileKind, string]>;

// Keep English name collation; distinct Unicode spellings must not depend on manifest order.
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "variant" }) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Directory listing for a folder (or site root) without an index file:
 * folders first, then files with their kind and size, then a gallery of the
 * folder's images. `appViewerUrl` links to the app-origin file browser.
 */
export function renderListing(live: LiveSite, dir: string, mode: ServeMode, appViewerUrl?: string, sort?: string | null, kind?: string | null): Response {
  const order = SORTS.find(([value]) => value === sort)?.[0] ?? "name";
  const selectedKind = KINDS.find(([value]) => value === kind)?.[0] ?? null;
  const base = mode.base + encodePath(dir);
  // Only recognized display state belongs on controls, never on content/navigation links.
  const controlUrl = (sortValue: typeof order, kindValue: FileKind | null): string => {
    const params = new URLSearchParams({ sort: sortValue });
    if (kindValue) params.set("kind", kindValue);
    return escapeHtml(`${base}?${params}`);
  };
  const sortLinks = `<nav class="sort" aria-label="Sort files"><span>Sort:</span>${SORTS.map(([value, label]) => `<a href="${controlUrl(value, selectedKind)}"${order === value ? ' aria-current="true"' : ""}>${label}</a>`).join("")}</nav>`;
  const kindLinks = `<nav class="filter" aria-label="File kinds in this folder"><span>Files in this folder:</span><a href="${controlUrl(order, null)}"${selectedKind === null ? ' aria-current="true"' : ""}>All</a>${KINDS.map(([value, label]) => `<a href="${controlUrl(order, value)}"${selectedKind === value ? ' aria-current="true"' : ""}>${escapeHtml(label)}</a>`).join("")}</nav>`;
  const dirs = new Map<string, number>();
  const files: Array<{ name: string; size: number; kind: ReturnType<typeof detectFileKind> }> = [];
  let total = 0;
  for (const [path, [, size, type]] of Object.entries(live.files)) {
    // .dropway/* is stored but never served, so listings do not name it either.
    if (path === ".dropway" || path.startsWith(".dropway/")) continue;
    if (!path.startsWith(dir)) continue;
    const rest = path.slice(dir.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({ name: rest, size, kind: detectFileKind(path, type) });
      total += size;
    } else {
      const d = rest.slice(0, slash);
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
  }
  const matchingFiles = selectedKind ? files.filter((f) => f.kind === selectedKind) : files;
  matchingFiles.sort((a, b) => {
    const primary = order === "size" ? b.size - a.size
      : order === "type" ? compareNames(KIND_LABELS[a.kind], KIND_LABELS[b.kind]) : 0;
    return primary || compareNames(a.name, b.name);
  });
  const items = [
    ...(dir ? [`<li class="dir"><a href="../">../</a><span></span><span></span></li>`] : []),
    ...[...dirs.entries()]
      .sort(([a], [b]) => compareNames(a, b))
      .map(([d, n]) => `<li class="dir"><a href="${escapeHtml(base + encodeURIComponent(d))}/">${escapeHtml(d)}/</a><span class="k">Folder</span><span>${n} file${n === 1 ? "" : "s"}</span></li>`),
    ...matchingFiles.map(
      (f) =>
        `<li><a href="${escapeHtml(base + encodeURIComponent(f.name))}">${escapeHtml(f.name)}</a><span class="k">${escapeHtml(KIND_LABELS[f.kind])}</span><span>${formatBytes(f.size)}</span></li>`,
    ),
  ];
  const images = matchingFiles.filter((f) => f.kind === "image" || f.kind === "svg").slice(0, GALLERY_MAX);
  const gallery = images.length
    ? `<div class="dw-gal" aria-label="Images in this folder">${images
        .map((f) => `<a href="${escapeHtml(base + encodeURIComponent(f.name))}"><img src="${escapeHtml(base + encodeURIComponent(f.name))}" alt="" loading="lazy" decoding="async"><span>${escapeHtml(f.name)}</span></a>`)
        .join("")}</div>`
    : "";
  const segs = dir.split("/").filter(Boolean);
  let acc = "";
  const crumb = [`<a href="${escapeHtml(mode.base)}">${escapeHtml(live.slug)}</a>`, ...segs.map((s) => {
    acc += `${s}/`;
    return `<a href="${escapeHtml(mode.base + encodePath(acc))}">${escapeHtml(s)}</a>`;
  })].join(" / ");
  const fileCount = selectedKind && files.length ? `${matchingFiles.length} of ${files.length} files` : `${files.length} file${files.length === 1 ? "" : "s"}`;
  const summary = `${dirs.size ? `${dirs.size} folder${dirs.size === 1 ? "" : "s"}, ` : ""}${fileCount} · ${formatBytes(total)}`;
  const noMatch = selectedKind && files.length && !matchingFiles.length ? `<p>No files of this kind. <a href="${controlUrl(order, null)}">Clear filter</a></p>` : "";
  const page = htmlPage({
    title: `${live.slug}/${dir}`,
    css: LISTING_CSS,
    head: '<meta name="robots" content="noindex">',
    body: `<main class="dw-ls"><header><h1>${crumb} /</h1><span class="sum">${summary}${appViewerUrl ? `<a href="${escapeHtml(appViewerUrl)}" rel="nofollow">Browse files</a>` : ""}</span>${sortLinks}${kindLinks}</header>${noMatch}<ul>${items.join("")}</ul>${gallery}</main>`,
  });
  return new Response(page, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Security-Policy": "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "X-Kofra-Viewer": "listing",
    },
  });
}
