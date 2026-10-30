import { appOrigin, detectFileKind, encodePath, KIND_LABELS, type DropwayContext, type FileKind, type LiveSite } from "@dropway/core";
import { domainsLine, escapeHtml, formatBytes, htmlPage } from "../html";
import { SKIP_LINK, siteFooter, siteHeader, TRUST_LINE } from "../ui/chrome";
import type { ThemePref } from "../ui/theme";
import type { ServeMode } from "../serve";
import { carryLink, type LinkCarry } from "./links";
import { unfurlHead } from "./unfurl";

// The rows keep the plain markup the sort contract pins (an anchor first, then <span class="k">): the thumbnail
// follows it in the source and is moved back to the first grid column here; the kind takes the .k-fkind look.
const LISTING_CSS = `
.k-listing>ul{list-style:none;margin:0;padding:0}
.k-frow>.k-thumb{order:-1}
.k-frow>.k{font:500 10.5px/1.3 var(--mono);text-transform:uppercase;letter-spacing:.11em;color:var(--accent-2)}
.k-sitehead-x{border-bottom:0;background:none}
.k-sitehead-x>.k-wrap{border-bottom:1px solid var(--rule-soft);background:var(--paper)}
.k-lhead{box-sizing:border-box;max-width:calc(60rem + 36px);margin:0 auto;padding:var(--s7) 18px 16px}
.k-sitehead-x+.k-listing{padding-top:0}
.k-listing>header>.k-lhead{padding:0 0 16px}
.k-sort{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:baseline;flex-basis:100%;font:400 12.5px/1.4 var(--mono);color:var(--muted)}
.k-sort a{padding:3px 7px;color:var(--ink-2)}
.k-sort a:hover{color:var(--accent)}
.k-sort a[aria-current]{background:var(--paper-3);color:var(--ink);font-weight:500}
@media (max-width:720px){.k-lhead{padding:var(--s6) 12px 16px}.k-listing .k-frow>.k{display:none}}
`;

const GALLERY_MAX = 60;
const SORTS = [["name", "Name"], ["size", "Largest first"], ["type", "Type"]] as const;

// Keep English name collation; distinct Unicode spellings must not depend on manifest order.
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "variant" }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** A 40px thumbnail by kind: a sheet for tables and data, a picture for images, a play mark for media, a folder for archives, else a page. */
export function thumbHtml(kind: FileKind | "folder"): string {
  const inner =
    kind === "folder" || kind === "archive"
      ? '<span class="k-th-folder"></span>'
      : kind === "csv" || kind === "json"
        ? '<span class="k-th-sheet"></span>'
        : kind === "image" || kind === "svg"
          ? '<span class="k-th-image"></span>'
          : kind === "video" || kind === "audio"
            ? '<span class="k-th-play"></span>'
            : '<span class="k-th-doc"><i></i><b></b><b class="k-s"></b></span>';
  return `<span class="k-thumb" aria-hidden="true">${inner}</span>`;
}

/**
 * Directory listing for a folder (or site root) without an index file:
 * folders first, then files with their kind and size, then a gallery of the
 * folder's images. `appViewerUrl` links to the app-origin file browser.
 * `embed` (inside the app's file viewer frame): no header, footer or "Browse files" of its own, and every
 * link keeps the embed and the mode (links.ts).
 */
export function renderListing(live: LiveSite, dir: string, mode: ServeMode, appViewerUrl?: string, sort?: string | null, origin = "", opts: { dw?: DropwayContext; theme?: ThemePref; embed?: boolean } = {}): Response {
  const carry: LinkCarry = { theme: opts.theme ?? "auto", embed: !!opts.embed };
  const link = (path: string) => escapeHtml(carryLink(mode.base, path, carry));
  const order = sort === "size" || sort === "type" ? sort : "name";
  // A sorted render stays in its mode (and frame); in Auto outside the frame the href is just ?sort=.
  const keep = `${carry.theme === "auto" ? "" : `&amp;theme=${carry.theme}`}${carry.embed ? "&amp;embed=1" : ""}`;
  const sortLinks = `<nav class="k-sort" aria-label="Sort files"><span>Sort:</span>${SORTS.map(([value, label]) => `<a href="?sort=${value}${keep}"${order === value ? ' aria-current="true"' : ""}>${label}</a>`).join("")}</nav>`;
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
  const base = mode.base + encodePath(dir);
  files.sort((a, b) => {
    const primary = order === "size" ? b.size - a.size
      : order === "type" ? compareNames(KIND_LABELS[a.kind], KIND_LABELS[b.kind]) : 0;
    return primary || compareNames(a.name, b.name);
  });
  const folderThumb = thumbHtml("folder");
  const parent = mode.base + encodePath(dir.split("/").filter(Boolean).slice(0, -1).map((p) => `${p}/`).join(""));
  const items = [
    ...(dir ? [`<li class="k-frow">${folderThumb}<a class="k-fname" href="${link(parent)}">../</a><span class="k-fkind">Up</span><span class="k-num"></span></li>`] : []),
    ...[...dirs.entries()]
      .sort(([a], [b]) => compareNames(a, b))
      .map(([d, n]) => `<li class="k-frow"><a href="${link(`${base + encodeURIComponent(d)}/`)}" class="k-fname">${escapeHtml(d)}/</a><span class="k">Folder</span><span class="k-num">${n} file${n === 1 ? "" : "s"}</span>${folderThumb}</li>`),
    ...files.map(
      (f) =>
        `<li class="k-frow"><a href="${link(base + encodeURIComponent(f.name))}" class="k-fname">${escapeHtml(f.name)}</a><span class="k">${escapeHtml(KIND_LABELS[f.kind])}</span><span class="k-num">${formatBytes(f.size)}</span>${thumbHtml(f.kind)}</li>`,
    ),
  ];
  const images = files.filter((f) => f.kind === "image" || f.kind === "svg").slice(0, GALLERY_MAX);
  const gallery = images.length
    ? `<div class="dw-gal"><h2 class="k-sr">Images in this folder</h2><ul class="k-gallery">${images
        .map((f) => `<li><a href="${link(base + encodeURIComponent(f.name))}"><img src="${escapeHtml(base + encodeURIComponent(f.name))}" alt="" loading="lazy" decoding="async"><span>${escapeHtml(f.name)}</span></a></li>`)
        .join("")}</ul></div>`
    : "";
  const segs = dir.split("/").filter(Boolean);
  let acc = "";
  const crumb = [`<a href="${link(mode.base)}">${escapeHtml(live.slug)}</a>`, ...segs.map((s) => {
    acc += `${s}/`;
    return `<a href="${link(mode.base + encodePath(acc))}">${escapeHtml(s)}</a>`;
  })].join('<span class="k-sep" aria-hidden="true">/</span>');
  const summary = `${dirs.size ? `${dirs.size} folder${dirs.size === 1 ? "" : "s"}, ` : ""}${files.length} file${files.length === 1 ? "" : "s"} · ${formatBytes(total)}`;
  const dw = opts.dw;
  const app = dw ? appOrigin(dw) : undefined;
  const name = dw?.config.instanceName ?? "Kofra";
  const title = `${live.slug}/${dir}`;
  // The path, summary and sort are the listing's <header>: under the site bar (the same header) or, in the frame, atop <main>.
  const head = `<div class="k-vhead k-lhead"><div><nav class="k-crumbs" aria-label="Path">${crumb}<span class="k-sep" aria-hidden="true">/</span></nav><h1>${escapeHtml(segs.length ? `${segs[segs.length - 1]}/` : live.slug)}</h1><p class="k-small"><span class="sum">${summary}</span></p></div>${appViewerUrl && !carry.embed ? `<a class="k-btn k-sm k-ghost" href="${escapeHtml(appViewerUrl)}" rel="nofollow">Browse files</a>` : ""}${sortLinks}</div>`;
  const top = app && !carry.embed ? SKIP_LINK + siteHeader(name, app, head) : "";
  const page = htmlPage({
    title,
    css: LISTING_CSS,
    head: unfurlHead({ title, description: `Folder listing · ${summary}`, url: origin + base }),
    delivery: "site",
    theme: opts.theme,
    appOrigin: app,
    body: `${top}<main class="k-listing" id="dw-main">${top ? "" : `<header>${head}</header>`}<h2 class="k-sr">Files</h2><ul>${items.join("")}</ul>${gallery}</main>${
      carry.embed ? "" : app && dw ? siteFooter({ name, appOrigin: app, domains: domainsLine(dw), trust: true }) : `<p class="k-trust k-vtrust">${TRUST_LINE}</p>`
    }`,
  });
  return new Response(page, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Security-Policy": `default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline';${app ? ` font-src ${app};` : ""} base-uri 'none'; form-action 'none'`,
      "X-Kofra-Viewer": "listing",
    },
  });
}
