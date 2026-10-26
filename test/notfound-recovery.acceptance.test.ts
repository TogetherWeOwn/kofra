/**
 * Recovery links on Kofra's own fallback pages: a stale, moved or mistyped
 * file link leads back to the site instead of ending the visit.
 *
 * These tests ARE the spec. The link tests must fail on the baseline (the
 * fallback pages carry no recovery links) and a builder makes them pass
 * without editing this file. The preservation tests (custom 404.html, SPA
 * fallback, pre-gate password pages, HEAD, renamed-slug 308) already pass
 * and must keep passing byte-for-byte.
 *
 * Contract (builder: implement exactly this):
 * - File-not-found page (post-password-gate 404): plain anchors, in this
 *   order, and no others:
 *   1. the site's home: href is exactly the current serving-mode base
 *      (`mode.base`: `/s/<slug>/` on the shared origin, `/<slug>/` on a
 *      separate sites origin, `/` in subdomain mode);
 *   2. the nearest ancestor folder, omitted when none exists: the longest
 *      proper ancestor directory of the requested path (with trailing "/")
 *      that prefixes at least one path in the already-loaded live manifest
 *      (the site root never counts; it is link 1). Href is
 *      `mode.base + encodePath(dir)`. Compute it from `live.files` only:
 *      no extra D1/R2/KV read, endpoint or script;
 *   3. "Browse files" (exact label) to the app-origin file browser, built
 *      exactly as the folder listing builds it for that same directory:
 *      `${appOrigin}/v/${slug}/${encodePath(dir)}`, where `dir` is the
 *      ancestor from (2), or "" (the site root) when there is none.
 *   Labels for (1) and (2) are any discernible text; all links are real
 *   anchors under the existing system-page styles, with no JavaScript.
 * - Empty-site page (site exists, no live version, 404): the one anchor is
 *   the existing `{app}` substitution: href is the app origin, text is the
 *   instance name. No dashboard/sign-in link, nothing promising owner access.
 * - Unreadable-file page (manifest lists the file, its bytes cannot be
 *   read, 502): the one anchor is "Try again" (exact label), href rebuilt
 *   as `mode.base + encodePath(path)` for the file that could not be read.
 *   Never copy the raw request URL: no query string at all, so preview,
 *   claim, unlock or bearer parameters can never leak into the page.
 * - Preserved on all three pages: status codes, `Cache-Control: no-store`,
 *   the system-page CSP, HEAD returning no body. A site's own `404.html`
 *   and the SPA fallback serve exactly the bytes they serve today.
 *   Recovery links appear only after the password gate has passed, exactly
 *   as listings do today: the password form and the pre-gate 403 gain no
 *   anchors and reveal no file or folder names. Renamed slugs still 308.
 * - Every interpolated path segment is percent-encoded (encodePath) and
 *   HTML-escaped; hostile, Unicode and markup-bearing names render as
 *   inert text with correct hrefs, including folders named `__proto__`.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { sha256Hex } from "@dropway/core";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

const NAV = { Accept: "text/html,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" };
const SYSTEM_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";
const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

interface Anchor {
  href: string;
  text: string;
}

function decodeEntities(s: string): string {
  const map: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, name: string) => map[name]!);
}

/**
 * The visible text of an anchor's inner HTML: drop any nested tags by
 * scanning for "<" ... ">" spans, leaving the text between them. The
 * result is only compared in assertions; it is never rendered as HTML.
 * A "<" with no closing ">" is literal text, as is a lone ">".
 */
function innerText(inner: string): string {
  let out = "";
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "<") {
      const end = inner.indexOf(">", i + 1);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    out += inner[i];
    i += 1;
  }
  return out;
}

/** Every anchor on the page, in document order, with its visible text. */
function anchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({
      href: decodeEntities(m[1] ?? m[2] ?? ""),
      text: decodeEntities(innerText(m[3]!)).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

function hrefs(html: string): string[] {
  return anchors(html).map((a) => a.href);
}

/** Assert the shared system-page contract and return the body. */
async function systemHtml(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("content-security-policy") ?? "").toContain(SYSTEM_CSP);
  const html = await res.text();
  // Plain links only: no script is added, the narrow-width viewport stays,
  // and nothing suppresses the visible focus outline.
  expect(html).not.toMatch(/<script\b/i);
  expect(html).toContain('name="viewport"');
  expect(html).not.toMatch(/outline\s*:\s*(none|0)\b/i);
  expect(html).not.toMatch(/tabindex\s*=\s*"-1"/i);
  return html;
}

async function publish(dw: Instance, slug: string, files: Record<string, string>): Promise<void> {
  const res = await dw.json("/api/v1/publish", {
    key: dw.ownerKey,
    ...jsonBody({ slug, files: Object.entries(files).map(([path, content]) => ({ path, content })) }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.slug).toBe(slug);
}

const NESTED: Record<string, string> = {
  "index.html": "<p>home page</p>",
  "guides/deep/kept.txt": "kept",
  "guides/other.txt": "other",
  "only/sub/deep.txt": "deep",
  "top.txt": "top",
};

describe("file-not-found recovery links (path mode)", () => {
  it("links site home, the nearest manifest-backed ancestor and Browse files, in that order", async () => {
    const dw = await freshInstance();
    await publish(dw, "recovery-site", NESTED);

    // guides/deep/nope/ has no files; guides/deep/ does.
    const html = await systemHtml(await dw.call("/s/recovery-site/guides/deep/nope/missing.txt", { headers: NAV }), 404);
    expect(html).toContain("Page not found");
    expect(html).toContain("guides/deep/nope/missing.txt");
    const links = anchors(html);
    expect(links.map((a) => a.href)).toEqual([
      "/s/recovery-site/",
      "/s/recovery-site/guides/deep/",
      `${ORIGIN}/v/recovery-site/guides/deep/`,
    ]);
    for (const link of links) expect(link.text.length, `discernible text for ${link.href}`).toBeGreaterThan(0);
    expect(links[2]!.text).toBe("Browse files");
  });

  it("counts an ancestor whose files are all in sub-folders as having files", async () => {
    const dw = await freshInstance();
    await publish(dw, "recovery-nested-only", NESTED);

    // only/ holds no file directly, but only/sub/deep.txt is in the manifest.
    const html = await systemHtml(await dw.call("/s/recovery-nested-only/only/missing.txt", { headers: NAV }), 404);
    expect(hrefs(html)).toEqual([
      "/s/recovery-nested-only/",
      "/s/recovery-nested-only/only/",
      `${ORIGIN}/v/recovery-nested-only/only/`,
    ]);
  });

  it("omits the ancestor link when no ancestor folder has files", async () => {
    const dw = await freshInstance();
    await publish(dw, "recovery-flat", NESTED);

    for (const path of ["/s/recovery-flat/nope.txt", "/s/recovery-flat/nowhere/inner/missing.txt"]) {
      const html = await systemHtml(await dw.call(path, { headers: NAV }), 404);
      const links = anchors(html);
      expect(links.map((a) => a.href), path).toEqual(["/s/recovery-flat/", `${ORIGIN}/v/recovery-flat/`]);
      expect(links[1]!.text, path).toBe("Browse files");
    }
  });

  it("percent-encodes hrefs and renders hostile and Unicode names as inert text", async () => {
    const dw = await freshInstance();
    const folder = "été & <img src=x onerror=alert(1)>";
    const missingFile = "<b>manquant été.txt";
    await publish(dw, "hostile-recovery", {
      "index.html": "<p>home page</p>",
      [`${folder}/kept.txt`]: "kept",
      "__proto__/kept.txt": "kept too",
    });

    const html = await systemHtml(
      await dw.call(`/s/hostile-recovery/${enc(folder)}/${encodeURIComponent(missingFile)}`, { headers: NAV }),
      404,
    );
    expect(hrefs(html)).toEqual([
      "/s/hostile-recovery/",
      `/s/hostile-recovery/${enc(folder)}/`,
      `${ORIGIN}/v/hostile-recovery/${enc(folder)}/`,
    ]);
    // The names survive as escaped text in the message, never as markup.
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;manquant");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>manquant");

    // A __proto__ folder is ordinary manifest data, not a prototype.
    const proto = await systemHtml(await dw.call("/s/hostile-recovery/__proto__/missing.txt", { headers: NAV }), 404);
    expect(hrefs(proto)).toEqual([
      "/s/hostile-recovery/",
      "/s/hostile-recovery/__proto__/",
      `${ORIGIN}/v/hostile-recovery/__proto__/`,
    ]);
  });
});

describe("file-not-found recovery links (separate sites origin)", () => {
  it("builds home and ancestor hrefs from the /<slug>/ base, not a hard-coded /s/ prefix", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: "https://sites.example" });
    await publish(dw, "recovery-sites-origin", NESTED);

    const html = await systemHtml(
      await dw.call("https://sites.example/recovery-sites-origin/guides/deep/missing.txt", { headers: NAV }),
      404,
    );
    expect(hrefs(html)).toEqual([
      "/recovery-sites-origin/",
      "/recovery-sites-origin/guides/deep/",
      `${ORIGIN}/v/recovery-sites-origin/guides/deep/`,
    ]);
  });
});

describe("file-not-found recovery links (subdomain mode)", () => {
  it("builds home and ancestor hrefs from the subdomain base and Browse files from the app origin", async () => {
    const dw = await freshInstance({ appOrigin: "https://app.test", sitesMode: "subdomain", sitesDomain: "sites.test" });
    await publish(dw, "recovery-sub", NESTED);

    const html = await systemHtml(await dw.call("https://recovery-sub.sites.test/guides/deep/missing.txt", { headers: NAV }), 404);
    const links = anchors(html);
    expect(links.map((a) => a.href)).toEqual(["/", "/guides/deep/", "https://app.test/v/recovery-sub/guides/deep/"]);
    expect(links[2]!.text).toBe("Browse files");
  });
});

describe("empty-site page", () => {
  it("links the instance home through the {app} substitution and nothing else", async () => {
    const dw = await freshInstance();
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "empty-recovery" }) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const html = await systemHtml(await dw.call("/s/empty-recovery/", { headers: NAV }), 404);
    expect(html).toContain("Nothing published yet");
    // The {app} substitution: href is the app origin, text is the instance
    // name. No /dashboard or /login link promising owner access.
    expect(anchors(html)).toEqual([{ href: ORIGIN, text: "Kofra" }]);
  });
});

describe("unreadable-file page", () => {
  async function deleteBlob(content: string): Promise<void> {
    const sha = await sha256Hex(new TextEncoder().encode(content));
    await env.FILES.delete(`blobs/${sha}`);
    expect(await env.FILES.head(`blobs/${sha}`), "fixture blob is really gone").toBeNull();
  }

  it("offers Try again rebuilt from the path-mode base and the encoded file path, with no request query copied", async () => {
    const dw = await freshInstance();
    const content = "unreadable-content";
    await publish(dw, "unreadable-recovery", { "index.html": "<p>home page</p>", "docs/résumé à lire.txt": content });
    await deleteBlob(content);

    // No navigation headers: a plain fetch of the stored bytes. The query
    // carries canaries for every credential-shaped parameter name.
    const res = await dw.call(
      `/s/unreadable-recovery/docs/${encodeURIComponent("résumé à lire.txt")}` +
        "?dw_preview=preview-canary&claim=claim-canary&unlock=unlock-canary&access_token=bearer-canary",
    );
    const html = await systemHtml(res, 502);
    expect(html).toContain("File unavailable");
    expect(anchors(html)).toEqual([
      { href: `/s/unreadable-recovery/docs/${encodeURIComponent("résumé à lire.txt")}`, text: "Try again" },
    ]);
    for (const canary of ["preview-canary", "claim-canary", "unlock-canary", "bearer-canary", "dw_preview", "access_token"]) {
      expect(html, canary).not.toContain(canary);
    }
  });

  it("builds Try again from the subdomain base in subdomain mode", async () => {
    const dw = await freshInstance({ appOrigin: "https://app.test", sitesMode: "subdomain", sitesDomain: "sites.test" });
    const content = "sub-unreadable";
    await publish(dw, "unreadable-sub", { "index.html": "<p>home page</p>", "assets/page data.txt": content });
    await deleteBlob(content);

    const html = await systemHtml(
      await dw.call("https://unreadable-sub.sites.test/assets/page%20data.txt?token=sub-canary"),
      502,
    );
    expect(anchors(html)).toEqual([{ href: "/assets/page%20data.txt", text: "Try again" }]);
    expect(html).not.toContain("sub-canary");
  });
});

describe("password gate: recovery links only after the gate", () => {
  it("the locked form reveals no inventory and carries no anchors; the unlocked 404 carries the recovery links", async () => {
    const dw = await freshInstance();
    await publish(dw, "locked-recovery", NESTED);
    const lock = await dw.json("/api/v1/sites/locked-recovery/access", {
      method: "PUT",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "password", password: "secret1" }),
    });
    expect(lock.status).toBe(200);

    const gate = await systemHtml(await dw.call("/s/locked-recovery/guides/deep/missing.txt", { headers: NAV }), 401);
    expect(gate).toContain('type="password"');
    expect(anchors(gate)).toEqual([]);
    expect(gate).not.toContain("Browse files");
    // The form's hidden `next` field echoes the visitor's own requested
    // URL; that is not inventory. Names that exist only in the manifest
    // (and not in that URL) must not appear.
    for (const name of ["kept.txt", "other.txt", "top.txt", "only/sub"]) {
      expect(gate, name).not.toContain(name);
    }

    const unlock = await dw.call("/s/locked-recovery/__dropway/password", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=secret1",
    });
    expect(unlock.status).toBe(303);
    const cookie = unlock.headers.get("set-cookie")!.split(";")[0]!;

    const html = await systemHtml(
      await dw.call("/s/locked-recovery/guides/deep/missing.txt", { headers: { ...NAV, Cookie: cookie } }),
      404,
    );
    expect(hrefs(html)).toEqual([
      "/s/locked-recovery/",
      "/s/locked-recovery/guides/deep/",
      `${ORIGIN}/v/locked-recovery/guides/deep/`,
    ]);
  });

  it("the pre-gate 403 for other sites' sub-resources gains no links and reveals no inventory", async () => {
    const dw = await freshInstance({ appOrigin: "https://app.test", sitesMode: "subdomain", sitesDomain: "sites.test" });
    await publish(dw, "locked-sub", { ...NESTED, "app.js": "window.x = 1;" });
    const lock = await dw.json("/api/v1/sites/locked-sub/access", {
      method: "PUT",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "password", password: "secret1" }),
    });
    expect(lock.status).toBe(200);

    const html = await systemHtml(
      await dw.call("https://locked-sub.sites.test/app.js", {
        headers: { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors" },
      }),
      403,
    );
    expect(html).toContain("Not available here");
    expect(anchors(html)).toEqual([]);
    expect(html).not.toContain("Browse files");
    expect(html).not.toContain("guides");
    expect(html).not.toContain("kept.txt");
  });
});

describe("preserved serving contracts", () => {
  it("a site's own 404.html still wins, byte-for-byte as serving that file directly", async () => {
    const dw = await freshInstance();
    await publish(dw, "custom-404-recovery", { "index.html": "<p>home page</p>", "404.html": "<p>custom missing page</p>" });

    const direct = await dw.call("/s/custom-404-recovery/404.html", { headers: NAV });
    expect(direct.status).toBe(200);
    const directBytes = await direct.text();

    const missing = await dw.call("/s/custom-404-recovery/nope/missing.txt", { headers: NAV });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(directBytes);
  });

  it("SPA sites still fall back to index.html, byte-for-byte", async () => {
    const dw = await freshInstance();
    await publish(dw, "spa-recovery", { "index.html": "<p>spa home</p>" });
    const patch = await dw.json("/api/v1/sites/spa-recovery", {
      method: "PATCH",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spa: true }),
    });
    expect(patch.status).toBe(200);

    const home = await dw.call("/s/spa-recovery/", { headers: NAV });
    expect(home.status).toBe(200);
    const homeBytes = await home.text();

    const route = await dw.call("/s/spa-recovery/some/client/route", { headers: NAV });
    expect(route.status).toBe(200);
    expect(await route.text()).toBe(homeBytes);
  });

  it("HEAD on the file-404 and empty-site pages returns no body", async () => {
    const dw = await freshInstance();
    await publish(dw, "head-recovery", NESTED);
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "head-empty" }) });
    expect(created.status).toBe(201);

    for (const path of ["/s/head-recovery/guides/deep/missing.txt", "/s/head-empty/"]) {
      const res = await dw.call(path, { method: "HEAD", headers: NAV });
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("content-security-policy") ?? "", path).toContain(SYSTEM_CSP);
      expect(await res.text(), path).toBe("");
    }
  });

  it("a renamed slug still 308s to the new name with path and query kept", async () => {
    const dw = await freshInstance();
    await publish(dw, "old-recovery", NESTED);
    const renamed = await dw.json("/api/v1/sites/old-recovery/rename", {
      method: "POST",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newSlug: "new-recovery" }),
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

    const res = await dw.call("/s/old-recovery/guides/deep/missing.txt?x=1", { headers: NAV });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/s/new-recovery/guides/deep/missing.txt?x=1`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
