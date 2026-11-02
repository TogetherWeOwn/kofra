import type { Hono } from "hono";
import { siteUrl } from "@dropway/core";
import type { DropwayEnv } from "./env";
import { escapeHtml } from "./html";

/** Trusted app-origin code authenticates everything before handing bytes to an opaque frame. */
async function encryptedLoader() {
  const w = globalThis as any;
  const d = w.document;
  const status = d.getElementById("status");
  try {
    const token = new URLSearchParams(w.location.hash.slice(1)).get("key");
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Missing or invalid decryption key. Open the complete share URL, including its #key fragment.");
    if (!w.crypto?.subtle) throw new Error("Decryption requires HTTPS (or localhost) and a browser with WebCrypto.");
    const rawKey = Uint8Array.from(w.atob(token.replace(/-/g, "+").replace(/_/g, "/") + "="), (c: string) => c.charCodeAt(0));
    const key = await w.crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const response = await w.fetch(status.dataset.bundle, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    if (!response.ok) throw new Error("Unable to load the encrypted site. It may have expired or been removed.");
    // Bound untrusted transport before allocation, including chunked responses.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 24 * 1024 * 1024) { await reader.cancel(); throw new Error("Encrypted site is too large."); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    // Self-contained: this function is stringified into the served page, so the
    // magic lives in one local constant used for both the prefix check and decryption.
    const magic = "DWENC001";
    if (size < 36 || new TextDecoder().decode(bytes.subarray(0, 8)) !== magic) throw new Error("Invalid encrypted site format.");
    const plaintext = await w.crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(8, 20), tagLength: 128, additionalData: new TextEncoder().encode(magic) }, key, bytes.subarray(20));
    const bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext));
    if (bundle.format !== "dropway-encrypted-v1" || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 10000 || typeof bundle.entry !== "string") throw new Error("Invalid encrypted site contents.");
    const paths = new Set<string>();
    for (const file of bundle.files) {
      if (typeof file.path !== "string" || !file.path || file.path.startsWith("/") || /[\\\x00-\x1f]/.test(file.path) || file.path.split("/").some((s: string) => !s || s === "." || s === "..") || paths.has(file.path) || typeof file.data !== "string" || file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error("Invalid encrypted file.");
      paths.add(file.path);
    }
    if (!paths.has(bundle.entry)) throw new Error("Encrypted entry document is missing.");
    const frame = d.createElement("iframe");
    frame.title = "Decrypted site (isolated)";
    frame.setAttribute("sandbox", "allow-scripts allow-downloads");
    frame.style.cssText = "flex:1;width:100%;min-height:0;border:0;background:white";
    frame.addEventListener("load", () => {
      frame.contentWindow.postMessage(bundle, "*");
      status.textContent = "Site decrypted. Bundled scripts can read all decrypted files.";
    }, { once: true });
    frame.src = "/__dropway/encrypted-frame";
    d.body.append(frame);
  } catch (error) {
    status.textContent = error instanceof Error && /^(Missing|Decryption requires|Unable|Invalid|Encrypted)/.test(error.message)
      ? error.message : "Unable to decrypt: incorrect key or damaged ciphertext. Nothing has been opened.";
  }
}

/** No key enters this realm; content gets bytes without app-origin privileges, not an egress guarantee. */
function encryptedFrame() {
  const w = globalThis as any;
  const d = w.document;
  const receive = (event: any) => {
    if (event.source !== w.parent) return;
    w.removeEventListener("message", receive);
    const bundle = event.data;
    const files = new Map<string, { bytes: Uint8Array; type: string; url: string }>();
    const types: Record<string, string> = {
      html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
      json: "application/json", txt: "text/plain", md: "text/plain", svg: "image/svg+xml", png: "image/png",
      jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
      woff: "font/woff", woff2: "font/woff2", mp3: "audio/mpeg", mp4: "video/mp4", pdf: "application/pdf",
    };
    const virtual = "https://encrypted.invalid/";
    const fileUrl = (path: string) => new URL(path.split("/").map(encodeURIComponent).join("/"), virtual).href;
    const entryBase = fileUrl(bundle.entry);
    const resolve = (value: string, base = entryBase) => {
      try {
        const url = new URL(value, base);
        return url.origin === "https://encrypted.invalid" ? decodeURIComponent(url.pathname.slice(1)) : null;
      } catch { return null; }
    };
    for (const f of bundle.files) {
      const bytes = Uint8Array.from(w.atob(f.data), (c: string) => c.charCodeAt(0));
      const type = types[f.path.split(".").pop().toLowerCase()] ?? "application/octet-stream";
      files.set(f.path, { bytes, type, url: w.URL.createObjectURL(new w.Blob([bytes], { type })) });
    }
    const localUrl = (value: string, base = entryBase) => {
      const path = resolve(value, base);
      return path !== null && files.has(path) ? files.get(path)!.url : "about:blank";
    };
    const css = (text: string, base: string) => text.replace(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi, (_: string, _q: string, value: string) => `url("${localUrl(value, base)}")`);
    for (const [path, file] of files) if (file.type === "text/css") {
      file.url = w.URL.createObjectURL(new w.Blob([css(new TextDecoder().decode(file.bytes), fileUrl(path))], { type: file.type }));
    }
    // Return original authenticated bytes, not rewritten display HTML/CSS or decoded text.
    w.fetch = async (input: any, init?: any) => {
      const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") throw new TypeError("Encrypted sites support read-only bundled fetches.");
      const path = resolve(typeof input === "string" || input instanceof w.URL ? String(input) : input.url);
      const file = path === null ? undefined : files.get(path);
      return new w.Response(method === "HEAD" || !file ? null : file.bytes, { status: file ? 200 : 404, headers: { "Content-Type": file?.type ?? "text/plain" } });
    };
    const entry = files.get(bundle.entry)!;
    if (entry.type === "text/html") {
      const doc = new w.DOMParser().parseFromString(new TextDecoder().decode(entry.bytes), "text/html");
      // No source base/refresh can navigate or influence the trusted runtime.
      for (const e of doc.querySelectorAll("base,meta[http-equiv]")) e.remove();
      for (const e of doc.querySelectorAll("[src],[href],[poster],[srcset],[style]")) {
        for (const name of ["src", "href", "poster"]) if (e.hasAttribute(name)) {
          const value = e.getAttribute(name);
          if (name === "href" && e.tagName === "A") {
            e.setAttribute("href", localUrl(value));
            e.setAttribute("download", resolve(value)?.split("/").pop() ?? "file");
          } else e.setAttribute(name, localUrl(value));
        }
        e.removeAttribute("srcset");
        if (e.hasAttribute("style")) e.setAttribute("style", css(e.getAttribute("style"), entryBase));
      }
      for (const e of doc.querySelectorAll("style")) e.textContent = css(e.textContent, entryBase);
      d.open();
      d.write("<!doctype html>" + doc.documentElement.outerHTML);
      d.close();
    } else {
      d.body.textContent = "";
      if (entry.type.startsWith("image/")) {
        const image = d.createElement("img"); image.src = entry.url; image.alt = bundle.entry; d.body.append(image);
      } else if (entry.type.startsWith("text/") || entry.type === "application/json") {
        const pre = d.createElement("pre"); pre.textContent = new TextDecoder().decode(entry.bytes); d.body.append(pre);
      }
      const link = d.createElement("a"); link.href = entry.url; link.download = bundle.entry.split("/").pop(); link.textContent = "Download decrypted file"; d.body.append(link);
    }
  };
  w.addEventListener("message", receive);
}

export function installEncrypted(app: Hono<DropwayEnv>) {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  app.get("/__dropway/encrypted-loader.js", c => c.body(`(${encryptedLoader.toString()})();`, 200, { ...headers, "Content-Type": "text/javascript; charset=utf-8" }));
  // Wrangler keepNames injects __name into nested functions (same wrapper as ui/assets.ts).
  // Inline bootstrap means the content CSP never needs to permit app-origin script requests.
  const frameScript = `(function(){"use strict";var __name=function(t){return t};(${encryptedFrame.toString()})();})();`;
  app.get("/__dropway/encrypted-frame", c => c.html(`<!doctype html><meta charset="utf-8"><title>Isolated encrypted content</title><body><script>${frameScript}</script></body>`, 200, {
    ...headers,
    "Content-Security-Policy": `sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
  }));
  app.get("/__dropway/encrypted/:slug", c => {
    const slug = c.req.param("slug");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return c.notFound();
    const bundle = new URL("encrypted.bin?raw=1", siteUrl(c.get("dw"), slug));
    return c.html(`<!doctype html><meta charset="utf-8"><title>Encrypted site · Kofra</title><body style="margin:0;height:100dvh;display:flex;flex-direction:column"><main style="padding:.5rem 1rem"><h1 style="font-size:1rem;margin:0">Encrypted site</h1><p>Only open sites whose bundled scripts and executable content you trust. Malicious scripts can navigate this frame to send decrypted data to the server.</p><p id="status" data-bundle="${escapeHtml(bundle.href)}">Decrypting locally. The key is never sent to the server.</p><noscript>JavaScript is required to decrypt this site.</noscript></main><script src="/__dropway/encrypted-loader.js"></script></body>`, 200, {
      ...headers, "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; connect-src 'self' ${bundle.origin}; frame-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    });
  });
}
