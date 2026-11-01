import type { Context } from "hono";
import { appOrigin, encodePath, isSetUp, looksLikeSlug, requestPathToFilePath, siteUrl, type DropwayContext } from "@dropway/core";
import type { DropwayEnv } from "../env";
import type { UiSlots } from "../extensions";
import { mcpJsonSnippets } from "../discovery";
import { escapeHtml, formatBytes } from "../html";
import { renderAppPage, sitesCspSource, uiSlotsOf } from "./shell";

const e = escapeHtml;

function pageHead(title: string, sub: string, actions = ""): string {
  return `<div class="dw-pagehead"><div><h1 class="dw-h1">${e(title)}</h1>${sub ? `<p id="dw-sub">${sub}</p>` : ""}</div>${actions ? `<div class="dw-row">${actions}</div>` : ""}</div>`;
}

const NOSCRIPT = `<noscript><p class="dw-muted">The dashboard loads its data with JavaScript.</p></noscript>`;

/** Where sites are served, in words. */
function sitesWhere(dw: DropwayContext): string {
  const c = dw.config;
  const example = siteUrl(dw, "SITE");
  if (c.sitesMode === "subdomain") return `Each site on its own origin: <code>${e(example)}</code>`;
  if (c.sitesOrigin) return `On a separate sites origin, one folder per site: <code>${e(example)}</code>`;
  return `On this origin under <code>${e(c.sitesPathPrefix)}/</code>, sandboxed: <code>${e(example)}</code>`;
}

// ------------------------------------------------------------------ home

const HOME_CSS = `
.dw-hero{padding:1.5rem 0 1.75rem;max-width:46rem}
.dw-hero h1{font-size:clamp(2rem,4.5vw,2.8rem);line-height:1.08;letter-spacing:-.025em;margin:.35rem 0 .75rem}
.dw-hero .lede{font-size:1.1rem;color:var(--muted);margin:0 0 1.4rem;max-width:40rem}
.dw-eyebrow{font:600 .75rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin:0}
.dw-home{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:1.25rem;align-items:start}
.dw-home .dw-section{margin:0}
.dw-points{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1rem 1.5rem;margin:2rem 0 0;padding:0;list-style:none}
.dw-points li{border-top:1px solid var(--line);padding-top:.75rem;font-size:.92rem;color:var(--muted)}
.dw-points strong{display:block;color:var(--fg);margin-bottom:.2rem}
.dw-panel[hidden]{display:none}
.dw-panel p{font-size:.88rem;color:var(--muted);margin:.75rem 0 .4rem}
.dw-snipwrap{position:relative}
.dw-snipwrap .dw-snippet{padding-right:4.75rem}
.dw-snipwrap .dw-btn{position:absolute;top:.45rem;right:.45rem}
.dw-foot{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.88rem;display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;justify-content:space-between}
@media (max-width:860px){.dw-home{grid-template-columns:1fr}}
`;

function snippet(id: string, text: string): string {
  return `<div class="dw-snipwrap"><pre class="dw-snippet" id="${id}">${e(text)}</pre><button type="button" class="dw-btn small" data-copy="#${id}" hidden>Copy</button></div>`;
}

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
      `<p>One call publishes a page; the form field name is the file path.</p>${snippet(
        "dw-s-curl",
        `curl ${o}/api/v1/publish \\\n  -H "Authorization: Bearer $KOFRA_API_KEY" \\\n  -F "index.html=@index.html" -F "style.css=@style.css"`,
      )}<p>A folder or build: zip it and send the zip.</p>${snippet(
        "dw-s-zip",
        `cd dist && zip -qr ../site.zip . && cd ..\ncurl ${o}/api/v1/publish -H "Authorization: Bearer $KOFRA_API_KEY" \\\n  -H "Content-Type: application/zip" --data-binary @site.zip`,
      )}<p>Add <code>?slug=&lt;site&gt;</code> to publish a new version of the same site.</p>`,
    ],
    [
      "cli",
      "CLI",
      `<p>Hashes locally and uploads only files the server does not have.</p>${snippet(
        "dw-s-cli",
        `export KOFRA_API=${o}\nexport KOFRA_API_KEY=dw_...\nnpx kofra publish ./dist`,
      )}`,
    ],
    [
      "mcp",
      "MCP",
      `<p>Claude Code:</p>${snippet(
        "dw-s-mcp",
        `claude mcp add --transport http kofra ${o}/mcp \\\n  --header "Authorization: Bearer $KOFRA_API_KEY"`,
      )}${mcpJsonSnippets(o).map((sn, i) => `<p>${e(sn.title)}:</p>${snippet(i === 0 ? "dw-s-mcpjson" : "dw-s-vscodejson", sn.code)}`).join("")}`,
    ],
    [
      "docs",
      "Agent docs",
      `<p>Point an agent at these; they describe this instance, not a generic one.</p><ul class="dw-small"><li><a href="/connect">/connect</a>: one-line setup per agent client</li><li><a href="/llms.txt">/llms.txt</a>: how to publish, update and roll back</li><li><a href="/llms-full.txt">/llms-full.txt</a>: every endpoint, MCP tool and error code</li><li><a href="/skill.md">/skill.md</a>: Agent Skill (<code>npx skills add ${e(o)}</code>)</li><li><a href="/openapi.json">/openapi.json</a>: every REST operation</li><li><code>${e(o)}/mcp</code>: the MCP endpoint</li></ul>`,
    ],
  ];
  const tabList = tabs
    .map(([id, label], i) => `<button type="button" role="tab" id="dw-tab-${id}" aria-controls="dw-panel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${e(label)}</button>`)
    .join("");
  const panels = tabs.map(([id, , html], i) => `<div class="dw-panel" role="tabpanel" id="dw-panel-${id}" aria-labelledby="dw-tab-${id}"${i === 0 ? "" : " hidden"}>${html}</div>`).join("");
  const lim = dw.config.limits;
  const body = `<section class="dw-hero">
<p class="dw-eyebrow">Self-hosted · single tenant · on Cloudflare</p>
<h1>${e(name)}</h1>
<p class="lede">Publish a file, a folder or a whole site to a live URL in one call. Every publish is a version you can roll back to, and every file opens in the browser as what it is: pages, Markdown, code, data, images, PDFs and media, with the raw file one click away.</p>
<div class="dw-row" id="dw-home-cta"><a class="dw-btn primary" href="/login">Sign in</a><a class="dw-btn" href="#dw-agents">Connect an agent</a></div>
</section>
${
  setUp
    ? ""
    : `<div class="dw-callout"><strong>This instance is not set up yet.</strong> Create the owner with the <code>ADMIN_BOOTSTRAP_KEY</code> secret you configured: <a href="/login#setup">set it up in the browser</a>, or with curl:
${snippet("dw-s-setup", `curl -X POST ${o}/api/v1/setup \\\n  -H "Authorization: Bearer $ADMIN_BOOTSTRAP_KEY" \\\n  -H "Content-Type: application/json" -d '{"email":"you@example.com"}'`)}</div>`
}
<div class="dw-home">
<section class="dw-section" aria-labelledby="dw-quick-h"><header><h2 id="dw-quick-h">Publish from this browser</h2></header><div class="dw-pad" id="dw-quick"><p class="dw-muted dw-small">Sign in to drop a folder here.</p></div></section>
<section class="dw-section" id="dw-agents" aria-labelledby="dw-agents-h"><header><h2 id="dw-agents-h">Publish from an agent</h2></header><div class="dw-pad"><div class="dw-tabs" role="tablist" aria-label="Ways to publish">${tabList}</div>${panels}</div></section>
</div>
<ul class="dw-points">
<li><strong>Versions, not overwrites</strong>Each publish is immutable. Restoring an old one is instant: only the live pointer moves.</li>
<li><strong>Only new bytes travel</strong>Files are stored once by SHA-256. A republish uploads only what changed.</li>
<li><strong>Every file type viewable</strong>Add <code>?raw=1</code> for the stored bytes, <code>?view=source</code> for highlighted source.</li>
<li><strong>Sites</strong>${sitesWhere(dw)}.</li>
<li><strong>Publishing</strong>${anon ? `With an API key, or anonymously (anonymous sites expire after ${Math.round(dw.config.anonymous.ttlMs / 3600_000)} hours).` : "With an API key from this instance's owner. Anonymous publishing is off."} Files up to ${formatBytes(lim.maxFileBytes)}, ${lim.maxFiles.toLocaleString("en-US")} files per version.</li>
<li><strong>Yours</strong>Runs on its owner's Cloudflare account. Open source, MIT licensed.</li>
</ul>
<footer class="dw-foot"><span>${e(name)} runs <a href="https://github.com/TogetherWeOwn/kofra">Kofra</a>, open source under the MIT license.</span><span><a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI</a> · <a href="https://github.com/TogetherWeOwn/kofra/blob/main/docs/SELF_HOST.md">Host your own</a></span></footer>`;
  return renderAppPage(c, { title: name, page: "home", body, css: HOME_CSS, nav: false });
}

// ------------------------------------------------------------------ sign in

const AUTH_CSS = `.dw-auth{max-width:30rem;margin:4vh auto 0}.dw-auth h1{margin-bottom:1.25rem}.dw-auth details{margin:1rem 0}.dw-auth summary{cursor:pointer;font-weight:600;font-size:.92rem}`;

export async function loginPage(c: Context<DropwayEnv>): Promise<Response> {
  const dw = c.get("dw");
  const session = uiSlotsOf(c).session;
  const next = c.req.query("next");
  const sessionNote = session
    ? `<p class="dw-callout">People sign in with their account: <a class="dw-btn primary small" href="${e(session.signInPath + (next && next.startsWith("/") && !next.startsWith("//") ? `${session.signInPath.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}` : ""))}">Sign in with your account</a> Agents and scripts can also sign in here with an API key.</p>`
    : "";
  const setUp = await isSetUp(dw).catch(() => true);
  const bootstrapField = `<div class="dw-field"><label class="dw-label" for="%ID%">Bootstrap secret (ADMIN_BOOTSTRAP_KEY)</label><input class="dw-input" id="%ID%" name="secret" type="password" autocomplete="off" required><p class="dw-help">Sent once to this instance's API, never stored in the browser.</p></div>`;
  const setup = setUp
    ? ""
    : `<section class="dw-section" id="setup"><header><h2>Set up this instance</h2></header><form class="dw-pad" id="dw-setup" method="post" action="/login">
${bootstrapField.replaceAll("%ID%", "dw-setup-secret")}
<div class="dw-grid2"><div class="dw-field"><label class="dw-label" for="dw-setup-email">Your email</label><input class="dw-input" id="dw-setup-email" name="email" type="email" autocomplete="email"></div>
<div class="dw-field"><label class="dw-label" for="dw-setup-name">Name</label><input class="dw-input" id="dw-setup-name" name="name" autocomplete="name"></div></div>
<button type="submit" class="dw-btn primary">Create the owner</button><div class="dw-out" aria-live="polite"></div></form></section>`;
  const body = `<div class="dw-auth">
<h1 class="dw-h1">Sign in to ${e(dw.config.instanceName)}</h1>
<div id="dw-login-note"></div>
${sessionNote}${setup}
<section class="dw-section"><header><h2>API key</h2></header><form class="dw-pad" id="dw-signin" method="post" action="/login">
<div class="dw-field"><label class="dw-label" for="dw-key">API key</label><input class="dw-input dw-mono" id="dw-key" name="key" type="password" autocomplete="current-password" placeholder="dw_…" required spellcheck="false"></div>
<label class="dw-check"><input type="checkbox" name="remember"><span>Keep me signed in on this browser<span class="dw-sub">Otherwise the key is forgotten when this tab closes.</span></span></label>
<div class="dw-row" style="margin-top:.75rem"><button type="submit" class="dw-btn primary">Sign in</button></div>
<div id="dw-signin-out" aria-live="polite" style="margin-top:.75rem"></div>
</form></section>
<p class="dw-small dw-muted">Keys come from the instance owner: the owner key is created at setup, and anyone with the <code>keys:write</code> scope can create more under API keys. The key is only ever sent to this instance's API.</p>
${
  setUp
    ? `<details><summary>Lost the owner key?</summary><form class="dw-section dw-pad" id="dw-recover" method="post" action="/login" style="margin-top:.6rem">${bootstrapField.replaceAll("%ID%", "dw-recover-secret")}<button type="submit" class="dw-btn">Create a new owner key</button><div class="dw-out" aria-live="polite"></div></form></details>`
    : ""
}
${NOSCRIPT}
</div>`;
  return renderAppPage(c, { title: "Sign in", page: "login", body, css: AUTH_CSS, nav: false });
}

// ------------------------------------------------------------------ dashboard

export function sitesPage(c: Context<DropwayEnv>): Promise<Response> {
  return renderAppPage(c, {
    title: "Sites",
    page: "sites",
    active: "/dashboard",
    body: `${pageHead("Sites", '<span id="dw-sites-count">Loading…</span>', '<a class="dw-btn primary" href="/dashboard/publish">Publish</a>')}<div id="dw-sites">${NOSCRIPT}</div>`,
  });
}

export function sitePage(c: Context<DropwayEnv>): Promise<Response> {
  const slug = c.req.param("slug") ?? "";
  return renderAppPage(c, {
    title: slug,
    page: "site",
    active: "/dashboard",
    data: { slug },
    body: `<nav class="dw-small" aria-label="Breadcrumb" style="margin:0 0 .75rem"><a href="/dashboard">Sites</a> / <span class="dw-mono">${e(slug)}</span></nav><div id="dw-site">${NOSCRIPT}</div>`,
  });
}

export function publishPage(c: Context<DropwayEnv>): Promise<Response> {
  return renderAppPage(c, {
    title: "Publish",
    page: "publish",
    active: "/dashboard/publish",
    body: `${pageHead("Publish", "Drop a build folder, some files or a .zip. Agents do the same with one API call, the CLI or MCP.")}<section class="dw-section"><div class="dw-pad" id="dw-publish">${NOSCRIPT}</div></section>`,
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
    ["App and API", `<code>${e(appOrigin(dw))}</code>`],
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
      const html = await Promise.resolve(s.render(c)).catch((err) => `<p class="dw-error">${e(String(err))}</p>`);
      return `<section class="dw-section" id="${e(s.id)}"><header><h2>${e(s.title)}</h2></header><div class="dw-pad">${html}</div></section>`;
    }),
  );
  const body = `${pageHead("Settings", "How this instance is configured. Change these with Worker variables (wrangler.jsonc) and redeploy.")}
<section class="dw-section"><header><h2>Your account</h2></header><div class="dw-pad" id="dw-me">${NOSCRIPT}</div></section>
<section class="dw-section"><header><h2>Members</h2><span class="dw-small dw-muted">People and agents who can sign in. Each gets their own keys.</span></header><div id="dw-members">${NOSCRIPT}</div></section>
<section class="dw-section"><header><h2>This instance</h2></header><div class="dw-pad"><dl class="dw-kv">${rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${v}</dd>`).join("")}</dl></div></section>
${extra.join("")}`;
  return renderAppPage(c, { title: "Settings", page: "settings", active: "/dashboard/settings", body });
}

// ------------------------------------------------------------------ file viewer

const VIEWER_PAGE_CSS = `
body.dw-wide{height:100vh;min-height:0;overflow:hidden}
.dw-side{width:17.5rem;flex:none;border-right:1px solid var(--line);background:var(--card);overflow:auto;display:flex;flex-direction:column;gap:.6rem;padding:.75rem}
.dw-tree-head{display:flex;flex-direction:column;gap:.1rem;padding:0 .25rem}
.dw-tree-note{font-size:.88rem;color:var(--muted);padding:.25rem}
.dw-treebox{font-size:.86rem;line-height:1.35}
.dw-treebox ul{list-style:none;margin:0;padding:0 0 0 .85rem}
.dw-treebox>ul{padding-left:0}
.dw-treebox li{margin:0}
.dw-treebox summary{cursor:pointer;padding:.22rem .35rem;border-radius:5px;font-weight:600;color:var(--fg);list-style:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dw-treebox summary::-webkit-details-marker{display:none}
.dw-treebox summary::before{content:"▸";display:inline-block;width:1em;color:var(--muted)}
.dw-treebox details[open]>summary::before{content:"▾"}
.dw-treebox summary:hover,.dw-treebox a:hover{background:var(--code)}
.dw-treebox a{display:block;padding:.22rem .35rem .22rem 1.35rem;border-radius:5px;color:var(--fg);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dw-treebox a[aria-current]{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);font-weight:600}
.dw-viewer{flex:1;min-width:0;display:flex;flex-direction:column}
.dw-vtools{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;justify-content:space-between;padding:.5rem .9rem;border-bottom:1px solid var(--line);background:var(--bg);font-size:.85rem}
.dw-vtools #dw-fileinfo{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dw-vtools #dw-tools{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.dw-vtabs{display:flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}
.dw-vtabs button,.dw-vtabs a{border:0;border-left:1px solid var(--line);background:var(--card);padding:.28rem .7rem;font:inherit;font-size:.82rem;color:var(--muted);cursor:pointer;text-decoration:none}
.dw-vtabs :first-child{border-left:0}
.dw-vtabs [aria-selected=true]{color:var(--fg);font-weight:600;box-shadow:inset 0 -2px 0 var(--accent)}
.dw-vtabs [role=tab]:focus-visible{outline-offset:-3px}
.dw-view-panel{flex:1;min-height:0;display:flex}
.dw-frame{flex:1;width:100%;border:0;background:#fff}
@media (max-width:760px){.dw-main-wide{flex-direction:column}.dw-side{width:auto;max-height:32vh;border-right:0;border-bottom:1px solid var(--line)}}
`;

export function viewerPage(c: Context<DropwayEnv>): Response | Promise<Response> {
  const dw = c.get("dw");
  const slug = (c.req.param("slug") ?? "").toLowerCase();
  if (!looksLikeSlug(slug)) return c.notFound();
  const raw = new URL(c.req.url).pathname.slice(`/v/${encodeURIComponent(slug)}`.length).replace(/^\//, "");
  const decoded = requestPathToFilePath(`/${raw}`);
  if (decoded === null) return c.notFound();
  const path = decoded;
  const root = siteUrl(dw, slug);
  const fileUrl = root + encodePath(path.replace(/\/$/, "")) + (path.endsWith("/") ? "/" : "");
  const isDir = path === "" || path.endsWith("/");
  const mode = c.req.query("mode");
  const src = isDir ? fileUrl : mode === "source" ? `${fileUrl}?view=source&embed=1` : mode === "raw" ? `${fileUrl}?raw=1` : `${fileUrl}?view=1&embed=1`;
  const shared = sitesCspSource(dw) === "'self'";
  // A sandboxed frame. On a separate sites origin the page keeps that (different) origin so its own
  // storage works; on the shared origin it gets an opaque origin, like every site response there.
  const sandbox = `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-presentation${shared ? "" : " allow-same-origin"}`;
  const tools = isDir
    ? `<a class="dw-btn small" href="${e(fileUrl)}" target="_blank" rel="noopener">Open</a>`
    : `<div class="dw-vtabs"><a href="${e(`${fileUrl}?view=1&embed=1`)}" target="dw-frame">Rendered</a><a href="${e(`${fileUrl}?view=source&embed=1`)}" target="dw-frame">Source</a><a href="${e(`${fileUrl}?raw=1`)}" target="dw-frame">Raw</a></div><a class="dw-btn small" href="${e(`${fileUrl}?download=1`)}">Download</a><a class="dw-btn small" href="${e(fileUrl)}" target="_blank" rel="noopener">Open</a>`;
  const body = `<aside class="dw-side" id="dw-tree" aria-label="Files"><div class="dw-tree-note"><a class="dw-title" href="/dashboard/sites/${e(encodeURIComponent(slug))}">${e(slug)}</a>${NOSCRIPT}</div></aside>
<section class="dw-viewer" aria-label="Preview">
<div class="dw-vtools"><div id="dw-fileinfo"><span class="dw-mono">${e(path || "/")}</span></div><div id="dw-tools">${tools}</div></div>
<div id="dw-view-panel" class="dw-view-panel"><iframe id="dw-frame" name="dw-frame" class="dw-frame" src="${e(src)}" sandbox="${sandbox}" allow="clipboard-write; fullscreen; autoplay; encrypted-media; picture-in-picture" referrerpolicy="no-referrer" title="${e(`Preview of ${path || slug}`)}"></iframe></div>
</section>`;
  return renderAppPage(c, { title: path ? `${path.split("/").filter(Boolean).pop()} · ${slug}` : slug, page: "viewer", active: "/dashboard", wide: true, data: { slug, path, siteUrl: root }, css: VIEWER_PAGE_CSS, body });
}
