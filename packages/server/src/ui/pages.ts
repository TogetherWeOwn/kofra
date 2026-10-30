import type { Context } from "hono";
import { appOrigin, encodePath, isSetUp, looksLikeSlug, requestPathToFilePath, siteUrl, type DropwayContext } from "@dropway/core";
import type { DropwayEnv } from "../env";
import type { UiSlots } from "../extensions";
import { mcpJsonSnippets } from "../discovery";
import { escapeHtml, formatBytes } from "../html";
import { TRUST_LINE } from "./chrome";
import { SHORT_CODE, tok, urlCode } from "./code";
import { renderAppPage, sitesCspSource, uiSlotsOf } from "./shell";
import { themeOf, type ThemePref } from "./theme";
import { SOURCE_REPO } from "../repo";

const e = escapeHtml;

/** Page title row: serif h1, optional one-line subline, actions on the right. `sub` is trusted HTML. */
function pageHead(title: string, sub: string, actions = ""): string {
  return `<div class="k-pagehead"><div><h1>${e(title)}</h1>${sub ? `<p id="dw-sub">${sub}</p>` : ""}</div>${actions ? `<div class="k-btnrow">${actions}</div>` : ""}</div>`;
}

/** A dashboard block: paper surface, serif h2 header with optional tools, then the content (trusted HTML). */
function block(opts: { id?: string; title: string; titleId?: string; tools?: string; body: string }): string {
  const hid = opts.titleId ?? (opts.id ? `${opts.id}-h` : "");
  return `<section class="k-blk"${opts.id ? ` id="${e(opts.id)}"` : ""}${hid ? ` aria-labelledby="${e(hid)}"` : ""}><div class="k-blk-h"><h2${hid ? ` id="${e(hid)}"` : ""}>${e(opts.title)}</h2>${opts.tools ? `<div class="k-tools">${opts.tools}</div>` : ""}</div>${opts.body}</section>`;
}

const NOSCRIPT = `<noscript><p class="k-pad k-small">The dashboard loads its data with JavaScript.</p></noscript>`;

// Inline code helpers live in ./code (site-origin pages use them too); urlCode and SHORT_CODE stay exported here.
export { SHORT_CODE, urlCode };

/** Where sites are served, in words. */
function sitesWhere(dw: DropwayContext): string {
  const c = dw.config;
  const example = siteUrl(dw, "SITE");
  if (c.sitesMode === "subdomain") return `Each site on its own origin: ${urlCode(example)}`;
  if (c.sitesOrigin) return `On a separate sites origin, one folder per site: ${urlCode(example)}`;
  return `On this origin under ${tok(`${c.sitesPathPrefix}/`)}, sandboxed: ${urlCode(example)}`;
}

/**
 * A code block with a kicker and a Copy button (shown once the dashboard script runs). The commands and settings on
 * the home page wrap (`k-wrapped`), so the whole of each shows at every width; Copy copies the text as written.
 */
function codeblock(id: string, label: string, text: string): string {
  return `<div class="k-codeblock"><div class="k-codeblock-h"><span class="k-k">${e(label)}</span><button type="button" class="k-btn k-sm k-ghost" data-copy="#${id}" aria-label="Copy: ${e(label)}" hidden>Copy</button></div><pre id="${id}" class="k-wrapped" tabindex="0" role="region" aria-label="${e(label)}">${e(text)}</pre></div>`;
}

// ------------------------------------------------------------------ home

export async function homePage(c: Context<DropwayEnv>): Promise<Response> {
  const dw = c.get("dw");
  const o = appOrigin(dw);
  const name = dw.config.instanceName;
  const setUp = await isSetUp(dw).catch(() => true);
  const anon = dw.config.anonymous.enabled;
  const tabs: Array<[string, string, string]> = [
    [
      "curl",
      "curl",
      `<p class="k-small">One call publishes a page; the form field name is the file path.</p>${codeblock(
        "dw-s-curl",
        "Publish files",
        `curl ${o}/api/v1/publish \\\n  -H "Authorization: Bearer $KOFRA_API_KEY" \\\n  -F "index.html=@index.html" -F "style.css=@style.css"`,
      )}<p class="k-small">A folder or build: zip it and send the zip.</p>${codeblock(
        "dw-s-zip",
        "Publish a zip",
        `cd dist && zip -qr ../site.zip . && cd ..\ncurl ${o}/api/v1/publish -H "Authorization: Bearer $KOFRA_API_KEY" \\\n  -H "Content-Type: application/zip" --data-binary @site.zip`,
      )}<p class="k-small">Add ${tok("?slug=<site>")} to publish a new version of the same site.</p>`,
    ],
    [
      "cli",
      "CLI",
      `<p class="k-small">Hashes locally and uploads only files the server does not have.</p>${codeblock(
        "dw-s-cli",
        "Publish with the CLI",
        `export KOFRA_API=${o}\nexport KOFRA_API_KEY=dw_...\nnpx kofra publish ./dist`,
      )}`,
    ],
    [
      "mcp",
      "MCP",
      `<p class="k-small">Claude Code:</p>${codeblock(
        "dw-s-mcp",
        "Add the MCP server",
        `claude mcp add --transport http kofra ${o}/mcp \\\n  --header "Authorization: Bearer $KOFRA_API_KEY"`,
      )}${mcpJsonSnippets(o).map((sn, i) => `<p class="k-small">${e(sn.title)}:</p>${codeblock(i === 0 ? "dw-s-mcpjson" : "dw-s-vscodejson", sn.title, sn.code)}`).join("")}`,
    ],
    [
      "docs",
      "Agent docs",
      `<p class="k-small">Point an agent at these; they describe this instance, not a generic one.</p><ul class="k-small"><li><a href="/connect">/connect</a>: one-line setup per agent client</li><li><a href="/llms.txt">/llms.txt</a>: how to publish, update and roll back</li><li><a href="/llms-full.txt">/llms-full.txt</a>: every endpoint, MCP tool and error code</li><li><a href="/skill.md">/skill.md</a>: Agent Skill (${urlCode(`npx skills add ${o}`)})</li><li><a href="/openapi.json">/openapi.json</a>: every REST operation</li><li>${urlCode(`${o}/mcp`)}: the MCP endpoint</li></ul>`,
    ],
  ];
  const tabList = tabs
    .map(([id, label], i) => `<button type="button" role="tab" id="dw-tab-${id}" aria-controls="dw-panel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${e(label)}</button>`)
    .join("");
  const panels = tabs.map(([id, , html], i) => `<div role="tabpanel" id="dw-panel-${id}" aria-labelledby="dw-tab-${id}"${i === 0 ? "" : " hidden"}>${html}</div>`).join("");
  const lim = dw.config.limits;
  const points: Array<[string, string]> = [
    ["Versions, not overwrites", "Each publish is immutable. Restoring an old one is instant: only the live pointer moves."],
    ["Only new bytes travel", "Files are stored once by SHA-256. A republish uploads only what changed."],
    ["Every file type viewable", `Add ${tok("?raw=1")} for the stored bytes, ${tok("?view=source")} for highlighted source.`],
    // No full stop after the address: it would read as part of the URL.
    ["Sites", sitesWhere(dw)],
    [
      "Publishing",
      `${anon ? `With an API key, or anonymously (anonymous sites expire after ${Math.round(dw.config.anonymous.ttlMs / 3600_000)} hours).` : "With an API key from this instance's owner. Anonymous publishing is off."} Files up to ${formatBytes(lim.maxFileBytes)}, ${lim.maxFiles.toLocaleString("en-US")} files per version.`,
    ],
    ["Yours", `Runs on its owner's Cloudflare account. <a href="${SOURCE_REPO}">Open source</a>, MIT licensed.`],
  ];
  const setup = setUp
    ? ""
    : `<div class="k-banner k-warn" role="status"><div><strong>This instance is not set up yet.</strong> Create the owner with the ${tok("ADMIN_BOOTSTRAP_KEY")} secret you configured: <a href="/login#setup">set it up in the browser</a>, or with curl:${codeblock(
        "dw-s-setup",
        "Set up with curl",
        `curl -X POST ${o}/api/v1/setup \\\n  -H "Authorization: Bearer $ADMIN_BOOTSTRAP_KEY" \\\n  -H "Content-Type: application/json" -d '{"email":"you@example.com"}'`,
      )}</div></div>`;
  const body = `<section class="k-hero" aria-labelledby="dw-home-h"><div class="k-wrap"><div>
<p class="k-k"><span class="k-nowrap">Self-hosted</span> · <span class="k-nowrap">single tenant</span> · <span class="k-nowrap">on Cloudflare</span></p>
<h1 id="dw-home-h">${e(name)}</h1>
<p class="k-lede">Publish a file, a folder or a whole site to a live URL in one call. Every publish is a version you can roll back to, and every file opens in the browser as what it is: pages, Markdown, code, data, images, PDFs and media.</p>
<div class="k-btnrow" id="dw-home-cta"><a class="k-btn" href="/login">Sign in</a><a class="k-btn k-ghost" href="#dw-agents">Connect an agent</a></div>
</div><figure class="k-plate" aria-hidden="true"><span class="k-plate-art"></span></figure></div></section>
<div class="k-guilloche-band" aria-hidden="true"></div>
<section class="k-sec" aria-labelledby="dw-start-h"><div class="k-wrap">
<div class="k-sec-h"><span class="k-num">01</span><h2 id="dw-start-h">Publish</h2><p>From this browser, or from an agent with one API call, the CLI or MCP.</p></div>
${setup}
<div class="k-blocks">
${block({ title: "Publish from this browser", titleId: "dw-quick-h", body: `<div class="k-pad" id="dw-quick"><p class="k-small">Sign in to drop a folder here.</p></div>` })}
${block({ id: "dw-agents", title: "Publish from an agent", body: `<div class="k-pad"><div class="k-tabs" role="tablist" aria-label="Ways to publish">${tabList}</div>${panels}</div>` })}
</div></div></section>
<section class="k-sec" aria-labelledby="dw-why-h"><div class="k-wrap">
<div class="k-sec-h"><span class="k-num">02</span><h2 id="dw-why-h">How it works</h2></div>
<ul class="k-notes">${points.map(([t, p]) => `<li class="k-note"><h3>${e(t)}</h3><p>${p}</p></li>`).join("")}</ul>
</div></section>`;
  return renderAppPage(c, { title: name, page: "home", body, nav: false, bare: true });
}

// ------------------------------------------------------------------ sign in

export async function loginPage(c: Context<DropwayEnv>): Promise<Response> {
  const dw = c.get("dw");
  const session = uiSlotsOf(c).session;
  const next = c.req.query("next");
  const sessionNote = session
    ? `<div class="k-banner" role="note"><div>People sign in with their account. Agents and scripts can also sign in here with an API key.<div class="k-btnrow"><a class="k-btn k-sm" href="${e(session.signInPath + (next && next.startsWith("/") && !next.startsWith("//") ? `${session.signInPath.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}` : ""))}">Sign in with your account</a></div></div></div>`
    : "";
  const setUp = await isSetUp(dw).catch(() => true);
  const bootstrapField = `<div class="k-group"><label class="k-label" for="%ID%">Bootstrap secret (ADMIN_BOOTSTRAP_KEY)</label><input class="k-input k-mono" id="%ID%" name="secret" type="password" autocomplete="off" required><p class="k-hint">Sent once to this instance's API, never stored in the browser.</p></div>`;
  const name = e(dw.config.instanceName);
  // One panel per job, its heading inside it (the same pattern as the hosted sign-in page): the page h1 sits in
  // the first panel, the setup panel when the instance is not set up yet, else the API-key panel.
  const setup = setUp
    ? ""
    : `<section class="k-panel" id="setup" aria-labelledby="dw-setup-h"><p class="k-k">First run</p><h1 id="dw-setup-h">Set up ${name}</h1><p>Create the owner of this instance with the bootstrap secret you configured.</p><form id="dw-setup" method="post" action="/login">
${bootstrapField.replaceAll("%ID%", "dw-setup-secret")}
<div class="k-two"><div class="k-group"><label class="k-label" for="dw-setup-email">Your email</label><input class="k-input" id="dw-setup-email" name="email" type="email" autocomplete="email"></div>
<div class="k-group"><label class="k-label" for="dw-setup-name">Name</label><input class="k-input" id="dw-setup-name" name="name" autocomplete="name"></div></div>
<button type="submit" class="k-btn">Create the owner</button><div data-out aria-live="polite"></div></form></section>`;
  const keyHeading = setUp ? `<h1 id="dw-key-h">Sign in to ${name}</h1>` : `<h2 id="dw-key-h">Sign in with an API key</h2>`;
  const body = `<div class="k-narrow k-stack">
<div id="dw-login-note"></div>
${sessionNote}${setup}
<section class="k-panel" aria-labelledby="dw-key-h">${keyHeading}<p>Use an API key of this instance. It is only ever sent to this instance's API.</p><form id="dw-signin" method="post" action="/login">
<div class="k-group"><label class="k-label" for="dw-key">API key</label><input class="k-input k-mono" id="dw-key" name="key" type="password" autocomplete="current-password" placeholder="dw_…" required spellcheck="false"></div>
<label class="k-tog"><input type="checkbox" name="remember"><span>Keep me signed in on this browser<span class="k-sub">Otherwise the key is forgotten when this tab closes.</span></span></label>
<div class="k-btnrow"><button type="submit" class="k-btn">Sign in</button></div>
<div id="dw-signin-out" aria-live="polite"></div>
</form>
<p class="k-small k-panel-note">Keys come from the instance owner: the owner key is created at setup, and anyone with the ${tok("keys:write")} scope can create more under API keys.</p></section>
${
  setUp
    ? `<details class="k-how"><summary>Lost the owner key?</summary><form class="k-panel" id="dw-recover" method="post" action="/login">${bootstrapField.replaceAll("%ID%", "dw-recover-secret")}<button type="submit" class="k-btn k-ghost">Create a new owner key</button><div data-out aria-live="polite"></div></form></details>`
    : ""
}
${NOSCRIPT}
</div>`;
  return renderAppPage(c, { title: "Sign in", page: "login", body, nav: false });
}

// ------------------------------------------------------------------ dashboard

export function sitesPage(c: Context<DropwayEnv>): Promise<Response> {
  return renderAppPage(c, {
    title: "Sites",
    page: "sites",
    active: "/dashboard",
    trust: true,
    body: `${pageHead("Sites", '<span id="dw-sites-count">Loading…</span>', '<a class="k-btn" href="/dashboard/publish">Publish</a>')}<div id="dw-sites">${NOSCRIPT}</div>`,
  });
}

export function sitePage(c: Context<DropwayEnv>): Promise<Response> {
  const slug = c.req.param("slug") ?? "";
  return renderAppPage(c, {
    title: slug,
    page: "site",
    active: "/dashboard",
    data: { slug },
    trust: true,
    body: `<nav class="k-crumbs" aria-label="Breadcrumb"><a href="/dashboard">Sites</a><span class="k-sep" aria-hidden="true">/</span><span aria-current="page">${e(slug)}</span></nav><div id="dw-site">${NOSCRIPT}</div>`,
  });
}

export function publishPage(c: Context<DropwayEnv>): Promise<Response> {
  return renderAppPage(c, {
    title: "Publish",
    page: "publish",
    active: "/dashboard/publish",
    // It lists the files chosen for publishing: the trust line goes in the footer (PORT-SPEC 6.0, A08-A13).
    trust: true,
    body: `${pageHead("Publish", "Drop a build folder, some files or a .zip. Agents do the same with one API call, the CLI or MCP.")}${block({ title: "The press", titleId: "dw-publish-h", body: `<div class="k-pad" id="dw-publish">${NOSCRIPT}</div>` })}`,
  });
}

export function keysPage(c: Context<DropwayEnv>): Promise<Response> {
  return renderAppPage(c, {
    title: "API keys",
    page: "keys",
    active: "/dashboard/keys",
    body: `${pageHead("API keys", "Give every agent and person its own key, with only the scopes it needs. Keys are shown once and stored as a hash.")}<div id="dw-keys">${NOSCRIPT}</div>`,
  });
}

export async function settingsPage(c: Context<DropwayEnv>, slots: UiSlots): Promise<Response> {
  const dw = c.get("dw");
  const cfg = dw.config;
  const lim = cfg.limits;
  const rows: Array<[string, string]> = [
    ["Instance name", e(cfg.instanceName)],
    ["App and API", urlCode(appOrigin(dw))],
    ["Sites", sitesWhere(dw)],
    [
      "Sandbox on sites",
      cfg.sitesSandbox
        ? "On: pages run in an opaque origin (no cookies, storage or service workers)"
        : cfg.sitesSandboxAnonymous
          ? "Anonymous sites only (SITES_SANDBOX=auto)"
          : "Off",
    ],
    ["Anonymous publishing", cfg.anonymous.enabled ? `On: anonymous sites expire after ${Math.round(cfg.anonymous.ttlMs / 3600_000)} hours, ${cfg.anonymous.sitesPerHourPerIp} per IP per hour` : "Off (ANONYMOUS_PUBLISH)"],
    ["Largest file", formatBytes(lim.maxFileBytes)],
    ["Files per version", lim.maxFiles.toLocaleString("en-US")],
    ["Largest version", formatBytes(lim.maxSiteBytes)],
    ["One-call publish body", formatBytes(lim.oneShotMaxBytes)],
    ["Analytics", dw.env.ANALYTICS ? "Analytics Engine bound" : "Not bound"],
  ];
  const extra = await Promise.all(
    (slots.settingsSections ?? []).map(async (s) => {
      const html = await Promise.resolve(s.render(c)).catch((err) => `<p class="k-banner k-danger" role="alert">${e(String(err))}</p>`);
      return block({ id: s.id, title: s.title, body: `<div class="k-pad">${html}</div>` });
    }),
  );
  // Members are edited here; only the instance's own settings live in wrangler.jsonc (said on that block alone).
  const body = `${pageHead("Settings", "Your account, the members who can sign in, and how this instance is set up.")}
${block({ title: "Your account", titleId: "dw-me-h", body: `<div class="k-pad" id="dw-me">${NOSCRIPT}</div>` })}
${block({ title: "Members", titleId: "dw-members-h", tools: '<span class="k-small">People and agents who can sign in. Each gets their own keys.</span>', body: `<div id="dw-members">${NOSCRIPT}</div>` })}
${block({ title: "This instance", titleId: "dw-instance-h", tools: `<span class="k-small">Read-only here: change these in ${tok("wrangler.jsonc")} and redeploy.</span>`, body: `<div class="k-pad"><dl class="k-kv">${rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${v}</dd>`).join("")}</dl></div>` })}
${extra.join("")}`;
  return renderAppPage(c, { title: "Settings", page: "settings", active: "/dashboard/settings", body });
}

// ------------------------------------------------------------------ file viewer

/** Add &theme= to a viewer URL (only ?view=1 / ?view=source pages: Kofra-generated, never user files) for an explicit mode. */
export function withViewerTheme(url: string, pref: string): string {
  if (pref !== "light" && pref !== "dark") return url;
  return /[?&]view=(1|source)\b/.test(url) ? `${url}&theme=${pref}` : url;
}

/**
 * The frame address for a folder or raw file: through <site>/__dropway/open, which passes an explicit mode
 * (?theme=) and, for folders, the embed (&embed=1: the listing or the password gate drawn without a header
 * and footer of their own) on only to pages Kofra draws. Direct when there is nothing to pass on.
 */
export function openInFrameUrl(root: string, target: string, pref: ThemePref, embed = false): string {
  const explicit = pref === "light" || pref === "dark";
  if (!explicit && !embed) return target;
  const t = new URL(target);
  return `${root}__dropway/open?next=${encodeURIComponent(t.pathname + t.search)}${embed ? "&embed=1" : ""}${explicit ? `&theme=${pref}` : ""}`;
}

export function viewerPage(c: Context<DropwayEnv>): Response | Promise<Response> {
  const dw = c.get("dw");
  const slug = (c.req.param("slug") ?? "").toLowerCase();
  if (!looksLikeSlug(slug)) return c.notFound();
  const raw = new URL(c.req.url).pathname.slice(`/v/${encodeURIComponent(slug)}`.length).replace(/^\//, "");
  const decoded = requestPathToFilePath(`/${raw}`);
  if (decoded === null) return c.notFound();
  const path = decoded;
  const pref = themeOf(dw);
  const root = siteUrl(dw, slug);
  const fileUrl = root + encodePath(path.replace(/\/$/, "")) + (path.endsWith("/") ? "/" : "");
  const isDir = path === "" || path.endsWith("/");
  const mode = c.req.query("mode");
  // Folders and raw files may be the site's own bytes, so in an explicit mode they open through the site's
  // __dropway/open address, which adds ?theme= only when the frame will show a page Kofra draws.
  const target = isDir ? fileUrl : mode === "source" ? `${fileUrl}?view=source&embed=1` : mode === "raw" ? `${fileUrl}?raw=1` : `${fileUrl}?view=1&embed=1`;
  const src = isDir ? openInFrameUrl(root, target, pref, true) : mode === "raw" ? openInFrameUrl(root, target, pref) : withViewerTheme(target, pref);
  const shared = sitesCspSource(dw) === "'self'";
  // A sandboxed frame. On a separate sites origin the page keeps that (different) origin so its own
  // storage works; on the shared origin it gets an opaque origin, like every site response there.
  const sandbox = `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-presentation${shared ? "" : " allow-same-origin"}`;
  const tab = (label: string, href: string, on: boolean) => `<a href="${e(href)}" target="dw-frame"${on ? ' aria-current="page"' : ""}>${label}</a>`;
  const tools = isDir
    ? `<a class="k-btn k-sm k-ghost" href="${e(fileUrl)}" target="_blank" rel="noopener">Open</a>`
    : `<nav class="k-seg" aria-label="View">${tab("Rendered", withViewerTheme(`${fileUrl}?view=1&embed=1`, pref), mode !== "source" && mode !== "raw")}${tab("Source", withViewerTheme(`${fileUrl}?view=source&embed=1`, pref), mode === "source")}${tab("Raw", `${fileUrl}?raw=1`, mode === "raw")}</nav><a class="k-btn k-sm k-ghost" href="${e(`${fileUrl}?download=1`)}">Download</a><a class="k-btn k-sm k-ghost" href="${e(fileUrl)}" target="_blank" rel="noopener">Open</a>`;
  const body = `<div class="k-vapp"><aside class="k-vside" id="dw-tree" aria-label="Files"><div class="k-vside-h"><a class="k-title" href="/dashboard/sites/${e(encodeURIComponent(slug))}">${e(slug)}</a>${NOSCRIPT}</div></aside>
<section class="k-vcenter" aria-label="Preview">
<h1 class="k-sr" id="dw-vh">${e(path.split("/").filter(Boolean).pop() ?? slug)}</h1>
<div class="k-toolbar"><div class="k-vfile" id="dw-fileinfo"><span class="k-crumbs"><span aria-current="page">${e(path || "/")}</span></span></div><div class="k-tools" id="dw-tools">${tools}</div></div>
<p class="k-trust">${TRUST_LINE}</p>
<div id="dw-view-panel" class="k-vpanel"><iframe id="dw-frame" name="dw-frame" class="k-frame" src="${e(src)}" sandbox="${sandbox}" allow="clipboard-write; fullscreen; autoplay; encrypted-media; picture-in-picture" referrerpolicy="no-referrer" title="${e(`Preview of ${path || slug}`)}"></iframe></div>
</section></div>`;
  return renderAppPage(c, { title: path ? `${path.split("/").filter(Boolean).pop()} · ${slug}` : slug, page: "viewer", active: "/dashboard", wide: true, data: { slug, path, siteUrl: root, theme: pref }, body });
}
