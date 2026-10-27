/** Protected test-first contract. Build on this artifact; do not edit it in the implementation PR. */
import { env } from "cloudflare:test";
import { clearLiveMemoryCache, type LiveSite } from "@dropway/core";
import { zipSync, strToU8 } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { viewerBar } from "../packages/server/src/viewers/chrome";
import { toViewerFile, type ViewerContext } from "../packages/server/src/viewers/index";
import { databaseBoundary, request } from "./delivery-review-fixtures";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";
import { create, instance as transferInstance, recipientFile, SITES } from "./transfer-fixtures";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const FRAME = { Accept: "text/html", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" };
const slug = "sibling-navigation-fixture";
const base = `/s/${slug}/`;
const current = "name,value\nfixture,7\n";
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 1, 2, 3]);
const files: Record<string, string | Uint8Array> = {
  // Deliberately not insertion-ordered; nested contents must not enter docs' sequence.
  "docs/03 report.txt": "last\n", "docs/00 nested/a.txt": "nested first\n",
  "docs/02 data.csv": current, "docs/01 notes.md": "# First\n",
  "docs/00 nested/b.txt": "nested last\n", "alone/only.csv": current,
  "alpha.txt": "root first\n", "zeta.txt": "root last\n",
  "locale/Zebra.txt": "z\n", "locale/alpha.txt": "a\n", "locale/Äpfel.txt": "umlaut\n",
  "hostile/01 <img src=x onerror=alert(1)> & \"quote\" #?.md": "# Safe\n",
  "hostile/02 current.csv": current, "hostile/03 café 雪 100%.txt": "unicode\n",
  "media/01 image.png": png, "media/02 vector.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
  "media/03 notes.txt": "not an image\n",
};
let dw: Instance;

async function publish(instance: Instance, name: string, content: Record<string, string | Uint8Array>) {
  // Multipart filename serialization escapes literal quotes before the Worker sees them.
  const result = await instance.json("/api/v1/publish", { key: instance.ownerKey, ...jsonBody({
    site: name,
    files: Object.entries(content).map(([path, bytes]) => typeof bytes === "string"
      ? { path, content: bytes }
      : { path, content: btoa(String.fromCharCode(...bytes)), encoding: "base64" }),
  }) });
  expect([200, 201], `local publish ${name}: ${result.status}`).toContain(result.status);
  const live = await instance.json(`/api/v1/sites/${name}/files`, { key: instance.ownerKey });
  expect(live.status).toBe(200);
  expect(live.body.files.map((file: { path: string }) => file.path).sort(), "live manifest preserves literal fixture names").toEqual(Object.keys(content).sort());
  return result;
}

// HTMLRewriter parses real output. This is not a sanitizer or a tag-stripping regex.
const entities = (value: string) => value.replace(/&(amp|quot|apos|lt|gt|#39|#x27);/g, (_, key: string) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'", "#x27": "'" })[key]!);
type Link = { href: string; rel: string; title: string; label: string; text: string };
async function anchors(html: string, selector = '.dw-vbar a[rel="prev"], .dw-vbar a[rel="next"]') {
  const links: Link[] = [];
  let active: Link | undefined;
  await new HTMLRewriter().on(selector, {
    element(e) {
      active = { href: entities(e.getAttribute("href") ?? ""), rel: e.getAttribute("rel") ?? "", title: entities(e.getAttribute("title") ?? ""), label: entities(e.getAttribute("aria-label") ?? ""), text: "" };
      links.push(active);
      e.onEndTag(() => { active = undefined; });
    },
    text(t) { if (active) active.text += entities(t.text); },
  }).transform(new Response(html)).text();
  return links;
}
async function view(path: string, instance = dw) {
  const response = await instance.call(`${base}${path}`, { headers: NAV });
  expect(response.status).toBe(200);
  return { response, html: await response.text() };
}
function expectLink(link: Link | undefined, rel: "prev" | "next", href: string, name: string) {
  expect(link, `${rel} anchor for ${name}`).toBeDefined();
  expect(link!.href).toBe(href);
  expect(link!.rel).toBe(rel);
  expect(link!.text.trim()).toMatch(rel === "prev" ? /Previous/ : /Next/);
  expect(link!.title).toContain(name);
  expect(link!.label || link!.text).toContain(name);
  expect(new URL(link!.href, ORIGIN).search).toBe("");
}

beforeAll(async () => {
  dw = await freshInstance();
  await publish(dw, slug, files);
});

describe("same-folder sibling navigation", () => {
  it("links both neighbours of a mixed-kind middle file in listing name order", async () => {
    const links = await anchors((await view("docs/02%20data.csv")).html);
    expect(links).toHaveLength(2);
    expectLink(links.find(l => l.rel === "prev"), "prev", `${base}docs/01%20notes.md`, "01 notes.md");
    expectLink(links.find(l => l.rel === "next"), "next", `${base}docs/03%20report.txt`, "03 report.txt");
  });

  it.each([
    ["docs/01%20notes.md", "next", "docs/02%20data.csv", "02 data.csv"],
    ["docs/03%20report.txt", "prev", "docs/02%20data.csv", "02 data.csv"],
    ["docs/00%20nested/a.txt", "next", "docs/00%20nested/b.txt", "b.txt"],
    ["docs/00%20nested/b.txt", "prev", "docs/00%20nested/a.txt", "a.txt"],
    ["alpha.txt", "next", "zeta.txt", "zeta.txt"],
    ["zeta.txt", "prev", "alpha.txt", "alpha.txt"],
  ] as const)("%s has one adjacent direct file, never wraps or crosses a folder", async (path, rel, target, name) => {
    const links = await anchors((await view(path)).html);
    expect(links).toHaveLength(1);
    expectLink(links[0], rel, `${base}${target}`, name);
  });

  it("matches the real listing's Unicode/case ordering rather than insertion or code-unit order", async () => {
    const listing = await anchors((await view("locale/")).html, "a[href]");
    const names = ["Zebra.txt", "alpha.txt", "Äpfel.txt"];
    const order = listing.map(l => l.href).filter(h => names.some(n => h === `${base}locale/${encodeURIComponent(n)}`));
    expect(order).toHaveLength(3);
    for (let i = 0; i < order.length; i++) {
      const links = await anchors((await view(order[i]!.slice(base.length))).html);
      expect(links.map(l => l.href).sort()).toEqual([order[i - 1], order[i + 1]].filter(Boolean).sort());
    }
  });

  it("never names stored .dropway entries as siblings of visible root files", async () => {
    const name = "sibling-dropway-fixture";
    await publish(dw, name, {
      ".dropway/notes.txt": "hidden nested\n",
      "omega.txt": "last visible\n",
      ".dropway": "hidden root\n",
      "alpha.txt": "first visible\n",
    });
    // Unfiltered, the root ".dropway" entry sorts before "alpha.txt", so the
    // first visible file would gain it as a Previous neighbour.
    const first = await dw.call(`/s/${name}/alpha.txt`, { headers: NAV });
    expect(first.status).toBe(200);
    const firstLinks = await anchors(await first.text());
    expect(firstLinks).toHaveLength(1);
    expectLink(firstLinks[0], "next", `/s/${name}/omega.txt`, "omega.txt");
    const last = await dw.call(`/s/${name}/omega.txt`, { headers: NAV });
    expect(last.status).toBe(200);
    const lastLinks = await anchors(await last.text());
    expect(lastLinks).toHaveLength(1);
    expectLink(lastLinks[0], "prev", `/s/${name}/alpha.txt`, "alpha.txt");
    expect([...firstLinks, ...lastLinks].some(l => l.href.includes(".dropway") || l.title.includes(".dropway"))).toBe(false);
  });

  it("orders collation-equal siblings as the listing does, end to end", async () => {
    // Canonically equivalent spellings: English collation equates them, and
    // the listing breaks the tie by code unit (NFD "e" before NFC "é").
    const nfc = "\u00e9clair.txt";
    const nfd = "e\u0301clair.txt";
    const name = "sibling-collation-fixture";
    // Publish NFC first: the opposite of listing order.
    await publish(dw, name, { [nfc]: "nfc\n", "z-last.txt": "last\n", [nfd]: "nfd\n", "a-first.txt": "first\n" });
    const siteBase = `/s/${name}/`;
    const nfdRes = await dw.call(`${siteBase}${encodeURIComponent(nfd)}`, { headers: NAV });
    expect(nfdRes.status).toBe(200);
    const nfdLinks = await anchors(await nfdRes.text());
    expect(nfdLinks).toHaveLength(2);
    expectLink(nfdLinks.find(l => l.rel === "prev"), "prev", `${siteBase}a-first.txt`, "a-first.txt");
    expectLink(nfdLinks.find(l => l.rel === "next"), "next", `${siteBase}${encodeURIComponent(nfc)}`, nfc);
    const nfcRes = await dw.call(`${siteBase}${encodeURIComponent(nfc)}`, { headers: NAV });
    expect(nfcRes.status).toBe(200);
    const nfcLinks = await anchors(await nfcRes.text());
    expect(nfcLinks).toHaveLength(2);
    expectLink(nfcLinks.find(l => l.rel === "prev"), "prev", `${siteBase}${encodeURIComponent(nfd)}`, nfd);
    expectLink(nfcLinks.find(l => l.rel === "next"), "next", `${siteBase}z-last.txt`, "z-last.txt");
  });

  it("breaks collation-equal sibling ties by code unit, independent of manifest order", async () => {
    const nfc = "\u00e9clair.txt";
    const nfd = "e\u0301clair.txt";
    // The publish pipeline hands viewers a path-ordered manifest, which
    // already puts NFD before NFC, so the tiebreak itself is pinned
    // directly (as in the listing collation suite): the same entries in
    // NFC-first manifest order must still link NFD before NFC. Plain
    // localeCompare equates the pair and would keep manifest order.
    const entry = (): [string, number, string] => ["0".repeat(64), 4, "text/plain"];
    const files = Object.fromEntries([nfc, "z-last.txt", nfd, "a-first.txt"].map(path => [path, entry()]));
    const live = { v: 3, slug: "sibling-collation-fixture", files } as unknown as LiveSite;
    const siteBase = "/s/sibling-collation-fixture/";
    const barFor = (path: string) => viewerBar({
      dw: {},
      request: new Request(`${ORIGIN}${siteBase}${encodeURIComponent(path)}`),
      url: new URL(`${ORIGIN}${siteBase}${encodeURIComponent(path)}`),
      live,
      file: toViewerFile(path, "0".repeat(64), 4, "text/plain"),
      mode: "document",
      embed: false,
      fileUrl: `${siteBase}${encodeURIComponent(path)}`,
      viewUrl: `${siteBase}${encodeURIComponent(path)}?view=1`,
      sourceUrl: `${siteBase}${encodeURIComponent(path)}?view=source`,
      rawUrl: `${siteBase}${encodeURIComponent(path)}?raw=1`,
      downloadUrl: `${siteBase}${encodeURIComponent(path)}?download=1`,
      siteBase,
      appViewerUrl: `${siteBase}${encodeURIComponent(path)}`,
      readText: async () => "x\n",
      readBytes: async () => new Uint8Array([120, 10]),
    } as unknown as ViewerContext, []);
    const nfdLinks = await anchors(barFor(nfd));
    expect(nfdLinks).toHaveLength(2);
    expectLink(nfdLinks.find(l => l.rel === "prev"), "prev", `${siteBase}a-first.txt`, "a-first.txt");
    expectLink(nfdLinks.find(l => l.rel === "next"), "next", `${siteBase}${encodeURIComponent(nfc)}`, nfc);
    const nfcLinks = await anchors(barFor(nfc));
    expect(nfcLinks).toHaveLength(2);
    expectLink(nfcLinks.find(l => l.rel === "prev"), "prev", `${siteBase}${encodeURIComponent(nfd)}`, nfd);
    expectLink(nfcLinks.find(l => l.rel === "next"), "next", `${siteBase}z-last.txt`, "z-last.txt");
  });

  it("escapes hostile sibling names and encodes path segments without carrying request credentials or modes", async () => {
    const { html } = await view("hostile/02%20current.csv?view=source&claim=fixture-claim&dw_preview=fixture-preview&unlock=fixture-unlock&token=fixture-token&bearer=fixture-bearer");
    const links = await anchors(html);
    expect(links).toHaveLength(2);
    expectLink(links.find(l => l.rel === "prev"), "prev", `${base}hostile/01%20%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%20%26%20%22quote%22%20%23%3F.md`, '01 <img src=x onerror=alert(1)> & "quote" #?.md');
    expectLink(links.find(l => l.rel === "next"), "next", `${base}hostile/03%20caf%C3%A9%20%E9%9B%AA%20100%25.txt`, "03 café 雪 100%.txt");
    let injected = 0;
    await new HTMLRewriter().on(".dw-vbar img, .dw-vbar [onerror], .dw-vbar [onclick]", { element() { injected++; } }).transform(new Response(html)).text();
    expect(injected).toBe(0);
  });

  it("omits navigation and preserves baseline output for a single-file folder and embeds", async () => {
    for (const path of ["alone/only.csv", "docs/02%20data.csv?view=1&embed=1"]) {
      const { html } = await view(path);
      expect(await anchors(html)).toEqual([]);
      expect(html).toMatchSnapshot(path);
    }
  });

  it.each(["media/01%20image.png", "media/02%20vector.svg"])("leaves excluded image/SVG viewer output byte-identical: %s", async path => {
    const { html } = await view(path);
    expect(await anchors(html)).toEqual([]);
    expect(html).toMatchSnapshot(path);
  });

  it("reveals no sibling names at the password gate, then renders them after the existing unlock", async () => {
    const locked = "sibling-password-fixture";
    await publish(dw, locked, { "a-secret.txt": "a\n", "b-secret.txt": "b\n" });
    const setting = await dw.json(`/api/v1/sites/${locked}`, { method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "fixture-passphrase-only" }) });
    expect(setting.status).toBe(200);
    const gated = await dw.call(`/s/${locked}/a-secret.txt`, { headers: NAV });
    const html = await gated.text();
    expect(html).toContain('type="password"');
    expect(await anchors(html)).toEqual([]);
    expect(html).not.toContain("b-secret.txt");
    const unlocked = await dw.call(`/s/${locked}/__dropway/password`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" }, body: new URLSearchParams({ password: "fixture-passphrase-only", next: `/s/${locked}/a-secret.txt` }).toString() });
    const cookie = unlocked.headers.get("set-cookie");
    expect(cookie, "existing unlock must issue a cookie").toBeTruthy();
    const allowed = await dw.call(`/s/${locked}/a-secret.txt`, { headers: { ...NAV, Cookie: cookie!.split(";")[0]! } });
    expect(allowed.status).toBe(200);
    expectLink((await anchors(await allowed.text()))[0], "next", `/s/${locked}/b-secret.txt`, "b-secret.txt");
  });

  it("adds no D1/R2/KV reads to the already-loaded-manifest path", async () => {
    // Warm fragments equally before comparing two real responses for identical CSV bytes.
    await view("alone/only.csv");
    await view("docs/02%20data.csv");
    async function measured(path: string) {
      const counts = { d1: 0, r2: 0, kv: 0 };
      const DB = databaseBoundary(async sql => { counts.d1 += sql.length; });
      const counted = <T extends object>(binding: T, key: "r2" | "kv", methods: string[]): T => new Proxy(binding, { get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => { if (methods.includes(String(property))) counts[key]++; return value.apply(target, args); };
      } });
      clearLiveMemoryCache();
      const res = await request(dw, `${ORIGIN}${base}${path}`, { headers: NAV }, { DB, FILES: counted(env.FILES, "r2", ["get", "head", "list"]), CACHE: counted(env.CACHE, "kv", ["get", "getWithMetadata", "list"]) });
      expect(res.status).toBe(200);
      return { counts, html: await res.text() };
    }
    const alone = await measured("alone/only.csv");
    const siblings = await measured("docs/02%20data.csv");
    expect(alone.counts.kv, "exercise the real live-manifest read").toBeGreaterThan(0);
    expect(siblings.counts).toEqual(alone.counts);
    expect(await anchors(siblings.html)).toHaveLength(2);
  });

  it.each([
    ["docs/02%20data.csv?raw=1", NAV, current],
    ["docs/02%20data.csv?download=1", NAV, current],
    ["docs/02%20data.csv", { Accept: "*/*", "Sec-Fetch-Dest": "empty" }, current],
    ["media/01%20image.png", FRAME, png],
    ["media/02%20vector.svg", FRAME, files["media/02 vector.svg"]!],
  ])("preserves stored bytes outside viewer navigation: %s", async (path, headers, bytes) => {
    const res = await dw.call(`${base}${path}`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
  });
});

describe("every affected shared-bar viewer", () => {
  const examples = [
    { id: "markdown", name: "middle.md", body: "# Middle\n" },
    { id: "csv", name: "middle.csv", body: current },
    { id: "json", name: "middle.json", body: '{"fixture":true}' },
    { id: "code", name: "middle.ts", body: "export const fixture = true;\n" },
    { id: "source", name: "middle.html", body: "<p>Middle</p>", query: "?view=source" },
    { id: "html-frame", name: "middle.html", body: "<p>Middle</p>", query: "?view=1" },
    { id: "notebook", name: "middle.ipynb", body: '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}' },
    { id: "pdf", name: "middle.pdf", body: "%PDF-1.4\nfixture\n" },
    { id: "video", name: "middle.mp4", body: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) },
    { id: "audio", name: "middle.mp3", body: new Uint8Array([73, 68, 51, 3]) },
    { id: "font", name: "middle.woff2", body: new Uint8Array([119, 79, 70, 50, 0, 1]) },
    { id: "binary", name: "middle.bin", body: new Uint8Array([0, 255, 1, 254]), query: "?view=1" },
    { id: "archive", name: "middle.zip", body: zipSync({ "fixture.txt": strToU8("fixture") }) },
  ];
  it.each(examples)("$id exposes adjacent files and retires the old viewer validator", async sample => {
    const name = `sibling-${sample.id}-fixture`;
    await publish(dw, name, { "a.txt": "before\n", [sample.name]: sample.body, "z.txt": "after\n" });
    const res = await dw.call(`/s/${name}/${sample.name}${sample.query ?? ""}`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe(sample.id);
    const html = await res.text();
    const scripts: { src: string | null; text: string }[] = [];
    let script: (typeof scripts)[number] | undefined;
    await new HTMLRewriter().on("script", {
      element(e) { script = { src: e.getAttribute("src"), text: "" }; scripts.push(script); e.onEndTag(() => { script = undefined; }); },
      text(t) { if (script) script.text += t.text; },
    }).transform(new Response(html)).text();
    expect({ csp: res.headers.get("content-security-policy"), scripts }).toMatchSnapshot(`${sample.id} unchanged CSP and executable content`);
    const links = await anchors(html);
    expect.soft(links.map(l => l.href).sort()).toEqual([`/s/${name}/a.txt`, `/s/${name}/z.txt`]);
    // Retire the actual baseline HTTP validator, including its wrapper-only output.
    const baselineVersion = sample.id === "csv" || sample.id === "markdown" ? "2" : "1";
    expect(res.headers.get("etag")).not.toMatch(new RegExp(`^W/"${sample.id}@${baselineVersion}-`));
  });
});

describe("site-base isolation and transfer exclusions", () => {
  it.each(["subdomain", "dedicated-path"] as const)("uses the existing breadcrumb site base in %s mode", async mode => {
    const instance = await freshInstance(mode === "subdomain"
      ? { appOrigin: ORIGIN, sitesMode: "subdomain", sitesDomain: "siblings.example.test" }
      : { appOrigin: ORIGIN, sitesMode: "path", sitesOrigin: "https://siblings.example.test" });
    await publish(instance, "sibling-origin-fixture", { "nested/a name.md": "# First", "nested/b.csv": current });
    const site = mode === "subdomain" ? "https://sibling-origin-fixture.siblings.example.test" : "https://siblings.example.test/sibling-origin-fixture";
    const response = await instance.call(`${site}/nested/b.csv?view=1&claim=fixture`, { headers: NAV });
    expect(response.status).toBe(200);
    const links = await anchors(await response.text());
    expect(links).toHaveLength(1);
    const target = new URL(links[0]!.href, site);
    expect(target.href).toBe(`${site}/nested/a%20name.md`);
    expect(target.search).toBe("");
  });

  it("leaves transfer navigation as exact attachment bytes, never a viewer", async () => {
    const instance = await transferInstance();
    const transfer = await create(instance, { slug: "sibling-transfer-fixture", files: [
      { path: "a.csv", content: current, contentType: "text/csv" },
      { path: "b.md", content: "# Other", contentType: "text/markdown" },
    ] });
    const link = await recipientFile(instance, transfer, 0, "a.csv");
    expect(new URL(link).origin).toBe(SITES);
    const response = await instance.call(link, { headers: NAV });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-kofra-viewer")).toBeNull();
    expect(await response.text()).toBe(current);
  });
});

describe("manifest-dependent HTTP cache freshness", () => {
  it.each(["add", "remove"] as const)("does not return stale 304 after %s sibling with unchanged current bytes", async change => {
    dw = await freshInstance();
    const name = `sibling-cache-${change}-fixture`;
    const unchanged = { "b.csv": current };
    const withSibling = { ...unchanged, "a.txt": "new neighbour\n" };
    await publish(dw, name, change === "add" ? unchanged : withSibling);
    const path = `/s/${name}/b.csv`;
    const old = await dw.call(path, { headers: NAV });
    expect(old.status).toBe(200);
    const etag = old.headers.get("etag");
    expect(etag).toBeTruthy();
    await old.arrayBuffer();
    const rawBefore = await dw.call(`${path}?raw=1`);
    expect(await rawBefore.text()).toBe(current);
    await publish(dw, name, change === "add" ? withSibling : unchanged);
    const rawAfter = await dw.call(`${path}?raw=1`);
    expect(rawAfter.headers.get("etag")).toBe(rawBefore.headers.get("etag"));
    expect(await rawAfter.text()).toBe(current);
    const fresh = await dw.call(path, { headers: { ...NAV, "If-None-Match": etag! } });
    expect(fresh.status, "unchanged file hash must not hide changed manifest navigation").toBe(200);
    expect(fresh.headers.get("etag")).not.toBe(etag);
    const links = await anchors(await fresh.text());
    if (change === "add") expectLink(links[0], "prev", `/s/${name}/a.txt`, "a.txt");
    else expect(links).toEqual([]);
    const stable = await dw.call(path, { headers: { ...NAV, "If-None-Match": fresh.headers.get("etag")! } });
    expect(stable.status, "an unchanged live manifest still supports conditional caching").toBe(304);
  });
});
