// @ts-nocheck
/**
 * Browser code for the app-origin pages (home, sign-in, dashboard, file viewer).
 *
 * This whole file is ONE self-contained function. ./assets.ts serves its
 * source text (Function.prototype.toString) as /__dropway/ui/app-<hash>.js, so
 * there is no build step and no bundler config for embedding apps to copy.
 * Rules for editing:
 * - Never reference anything outside dropwayClient() (no imports, no module-level values).
 * - Plain modern JavaScript; TypeScript annotations would survive into the browser.
 * - Never put API data into innerHTML: build DOM with h() / text nodes.
 * - Every action calls the public REST API (/api/v1), the same one agents use.
 *
 * Type checking is off for this file (DOM types are not loaded in this Workers
 * project). The suite checks the served script is self-contained; flows were
 * checked in a real browser (see the PR / commit notes).
 */
export function dropwayClient() {
  "use strict";
  var d = document;
  var bootEl = d.getElementById("dw-boot");
  var boot = bootEl ? JSON.parse(bootEl.textContent || "{}") : {};
  var P = boot.page || {};
  var KEY = "dropway.key";
  var ME = "dropway.me";
  // Cookie sessions from an embedding app (uiSlots.session): { signIn, signOut } or null.
  var SESSION = boot.session || null;
  var sessionOk = false;
  var TEXT_KINDS = ["html", "markdown", "svg", "json", "csv", "code", "text", "notebook"];

  // ------------------------------------------------------------------ storage

  function store(kind) {
    try {
      return kind === "local" ? window.localStorage : window.sessionStorage;
    } catch (e) {
      return null;
    }
  }
  function getKey() {
    var s = store("session");
    var l = store("local");
    return (s && s.getItem(KEY)) || (l && l.getItem(KEY)) || "";
  }
  function setKey(k, remember) {
    var s = store("session");
    var l = store("local");
    if (s) {
      s.setItem(KEY, k);
      s.removeItem(ME);
    }
    if (l) {
      if (remember) l.setItem(KEY, k);
      else l.removeItem(KEY);
    }
  }
  function clearKey() {
    var s = store("session");
    var l = store("local");
    if (s) {
      s.removeItem(KEY);
      s.removeItem(ME);
    }
    if (l) l.removeItem(KEY);
  }

  /** Signed in: an API key in this browser, or (with uiSlots.session) a live cookie session. */
  function authed() {
    return !!getKey() || sessionOk;
  }

  /** Where to send people to sign in, coming back to `next` afterwards. */
  function signInHref(next, extra) {
    var base = SESSION ? SESSION.signIn : "/login";
    var q = (next ? "next=" + encodeURIComponent(next) : "") + (extra ? (next ? "&" : "") + extra : "");
    return q ? base + (base.indexOf("?") >= 0 ? "&" : "?") + q : base;
  }

  /** End the session: forget the key, and with cookie sessions POST to the embedding app's sign-out path. */
  function signOut() {
    var hadKey = !!getKey();
    clearKey();
    if (SESSION && (sessionOk || !hadKey)) {
      var f = h("form", { method: "post", action: SESSION.signOut, hidden: true });
      d.body.appendChild(f);
      f.submit();
      return;
    }
    location.href = "/login?signedout=1";
  }

  // ------------------------------------------------------------------ API

  function apiError(status, data, fallback) {
    var e = (data && data.error) || {};
    var err = new Error(e.message || fallback || "Request failed (HTTP " + status + ").");
    err.status = status;
    err.code = e.code || null;
    err.hint = e.hint || null;
    err.details = e.details || null;
    return err;
  }

  /** Same-origin path for an absolute URL the API returned (so the CSP stays 'self'). */
  function localPath(url) {
    try {
      var u = new URL(url, location.href);
      return u.pathname + u.search;
    } catch (e) {
      return url;
    }
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = new Headers(opts.headers || {});
    var key = opts.key !== undefined ? opts.key : getKey();
    if (key) headers.set("Authorization", "Bearer " + key);
    headers.set("X-Kofra-Client", "dashboard/1");
    var body = opts.body;
    var isRaw = typeof Blob !== "undefined" && body instanceof Blob;
    if (body !== undefined && body !== null && !isRaw && typeof body !== "string") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(body);
    }
    var url = path.charAt(0) === "/" && path.indexOf(boot.api) !== 0 && !opts.abs ? boot.api + path : path;
    var res;
    try {
      res = await fetch(url, { method: opts.method || (body !== undefined ? "POST" : "GET"), headers: headers, body: body });
    } catch (e) {
      throw apiError(0, null, "Could not reach the server. Check your connection and retry.");
    }
    if (opts.raw) {
      if (!res.ok) {
        var t = await res.text();
        var j = null;
        try {
          j = JSON.parse(t);
        } catch (e) {}
        throw apiError(res.status, j);
      }
      return res;
    }
    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {}
    if (!res.ok) {
      var err = apiError(res.status, data);
      if (res.status === 401 && key && opts.key === undefined && ["invalid_api_key", "key_expired", "unauthorized"].indexOf(err.code) >= 0) {
        clearKey();
        location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search) + "&expired=1";
      } else if (res.status === 401 && !key && sessionOk && opts.key === undefined) {
        sessionOk = false;
        location.href = signInHref(location.pathname + location.search, "expired=1");
      }
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------------ DOM helpers

  function h(tag, props) {
    var el = d.createElement(tag);
    if (props) {
      for (var k in props) {
        var v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.indexOf("on") === 0 && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "value") el.value = v;
        else if (k === "checked") el.checked = !!v;
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      }
    }
    for (var i = 2; i < arguments.length; i++) addOne(el, arguments[i]);
    return el;
  }
  /** add(el, child, child, ...): append children (nodes, strings, arrays; null/false skipped). */
  function add(el) {
    for (var i = 1; i < arguments.length; i++) addOne(el, arguments[i]);
    return el;
  }
  function addOne(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) {
      for (var i = 0; i < c.length; i++) addOne(el, c[i]);
      return;
    }
    el.appendChild(typeof c === "object" && c.nodeType ? c : d.createTextNode(String(c)));
  }
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }
  function $(sel, root) {
    return (root || d).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || d).querySelectorAll(sel));
  }

  function bytes(n) {
    if (n === null || n === undefined) return "";
    if (n < 1024) return n + " B";
    var u = ["KB", "MB", "GB", "TB"];
    var v = n / 1024;
    var i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return v.toFixed(v < 10 ? 1 : 0) + " " + u[i];
  }
  function exactBytes(n) {
    if (n === null || n === undefined) return "";
    return n.toLocaleString("en-US") + (n === 1 ? " byte" : " bytes");
  }
  function ago(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    var hr = Math.round(m / 60);
    if (hr < 24) return hr + " h ago";
    var days = Math.round(hr / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function encodePath(p) {
    return p.split("/").map(encodeURIComponent).join("/");
  }
  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  }

  function toast(msg, isError) {
    var box = d.getElementById("dw-toasts");
    if (!box) return;
    var t = h("div", { class: "dw-toast" + (isError ? " err" : "") , role: isError ? "alert" : null, text: msg });
    box.appendChild(t);
    setTimeout(function () {
      t.remove();
    }, isError ? 7000 : 3200);
  }

  function errorBox(err, prefix) {
    return h(
      "div",
      { class: "dw-error", role: "alert" },
      h("strong", { text: (prefix ? prefix + ": " : "") + (err && err.message ? err.message : String(err)) }),
      err && err.hint ? h("div", { class: "dw-small", text: err.hint }) : null,
      err && err.code ? h("div", { class: "dw-small dw-muted dw-mono", text: err.code }) : null,
    );
  }

  async function copyText(text, btn) {
    var ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      var ta = h("textarea", { style: "position:fixed;opacity:0;top:0;left:0" });
      ta.value = text;
      d.body.appendChild(ta);
      ta.select();
      try {
        ok = d.execCommand("copy");
      } catch (e2) {}
      ta.remove();
    }
    if (btn) {
      var old = btn.getAttribute("data-label") || btn.textContent;
      btn.setAttribute("data-label", old);
      btn.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(function () {
        btn.textContent = old;
      }, 1400);
    } else toast(ok ? "Copied" : "Copy failed", !ok);
    return ok;
  }
  function copyButton(getText, label) {
    return h("button", {
      type: "button",
      class: "dw-btn small",
      "aria-label": label || "Copy",
      text: "Copy",
      onclick: function (ev) {
        copyText(typeof getText === "function" ? getText() : getText, ev.currentTarget);
      },
    });
  }

  /** Keep receipt fields on one line; reject unsafe values rather than sanitizing them. */
  function publicReceiptField(value) {
    return typeof value === "string" && value && !/[\s\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null;
  }

  /** A publish response URL that is safe to share, or null. Never stripped or rebuilt. */
  function publicReceiptUrl(url) {
    if (!publicReceiptField(url)) return null;
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return url;
  }

  /** Plain-text public receipt: allowlisted response fields only, never secrets. */
  function publicReceiptText(siteUrl, version) {
    var lines = [];
    var clean = publicReceiptUrl(siteUrl);
    if (clean) lines.push("Site URL: " + clean);
    if (version && publicReceiptField(version.id)) lines.push("Version ID: " + version.id);
    if (version && typeof version.number === "number") lines.push("Version: " + version.number);
    if (version && typeof version.fileCount === "number") lines.push("Files: " + version.fileCount);
    if (version && typeof version.totalBytes === "number") lines.push("Total bytes: " + version.totalBytes);
    return lines.join("\n");
  }

  /** Copyable public receipt for a publish result. Local only: no requests, no persistence. */
  function receiptBlock(r) {
    var text = publicReceiptText(r.url, r.version);
    if (!text) return null;
    var busy = false;
    var label = "Copy public details";
    var note = h("div", { class: "dw-small", role: "status", text: "" });
    var area = h("textarea", {
      class: "dw-input dw-mono",
      readonly: true,
      rows: String(text.split("\n").length),
      spellcheck: "false",
      "aria-label": "Public details",
      value: text,
    });
    var btn = h("button", {
      type: "button",
      class: "dw-btn small",
      text: label,
      onclick: function () {
        if (busy) return;
        busy = true;
        btn.disabled = true;
        btn.textContent = "Copying…";
        var after = function (ok) {
          busy = false;
          btn.disabled = false;
          btn.textContent = label;
          note.textContent = ok
            ? "Public details copied."
            : "Could not copy automatically. Select the text above and copy it manually.";
        };
        try {
          var p = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : null;
          if (p && p.then) p.then(function () { after(true); }, function () { after(false); });
          else after(false);
        } catch (e) {
          after(false);
        }
      },
    });
    return h(
      "div",
      { style: "margin-top:.6rem" },
      h("div", { class: "dw-label", text: "Public details" }),
      area,
      h("div", { class: "dw-row", style: "margin-top:.4rem" }, btn),
      note,
      h("p", {
        class: "dw-small dw-muted",
        text: "The live site URL can change when a new version is published. This version receipt records what was published; it is not an immutable or pinned preview, and sharing it does not change access restrictions or passwords.",
      }),
    );
  }

  /** Modal confirmation. typeToConfirm: the user must type this value. Resolves true or false. */
  function confirmBox(opts) {
    return new Promise(function (resolve) {
      var input = opts.typeToConfirm ? h("input", { class: "dw-input", autocomplete: "off", spellcheck: "false", "aria-label": "Type " + opts.typeToConfirm + " to confirm" }) : null;
      var ok = h("button", { class: "dw-btn " + (opts.danger === false ? "primary" : "danger"), value: "ok", text: opts.confirmText || "Confirm", disabled: !!input });
      var dlg = h(
        "dialog",
        { class: "dw-dialog", "aria-labelledby": "dw-dlg-title" },
        h(
          "form",
          { method: "dialog" },
          h("h2", { id: "dw-dlg-title", text: opts.title }),
          opts.message ? h("p", { class: "dw-muted", text: opts.message }) : null,
          input ? h("label", { class: "dw-label", text: "Type " + opts.typeToConfirm + " to confirm" }) : null,
          input,
          h("div", { class: "dw-row" }, h("button", { type: "button", class: "dw-btn", value: "cancel", text: "Cancel", onclick: function () { dlg.close("cancel"); } }), ok),
        ),
      );
      if (input)
        input.addEventListener("input", function () {
          ok.disabled = input.value.trim() !== opts.typeToConfirm;
        });
      dlg.addEventListener("close", function () {
        var yes = dlg.returnValue === "ok" && (!input || input.value.trim() === opts.typeToConfirm);
        dlg.remove();
        resolve(yes);
      });
      d.body.appendChild(dlg);
      dlg.showModal();
      (input || ok).focus();
    });
  }

  /** A secret shown once, with Copy. */
  function secretBlock(title, value, note) {
    return h(
      "div",
      { class: "dw-callout", role: "status" },
      h("strong", { text: title }),
      h("div", { class: "dw-secret" }, h("code", { text: value }), copyButton(value, "Copy key")),
      note ? h("div", { class: "dw-small dw-muted", text: note }) : null,
    );
  }

  function skeleton(n) {
    var out = [];
    for (var i = 0; i < (n || 3); i++) out.push(h("div", { class: "dw-skel", "aria-hidden": "true" }));
    return h("div", { "aria-busy": "true", "aria-label": "Loading" }, out);
  }

  function safeNext(n) {
    return n && n.charAt(0) === "/" && n.charAt(1) !== "/" && n.charAt(1) !== "\\" ? n : "/dashboard";
  }

  // ------------------------------------------------------------------ account

  async function me() {
    var s = store("session");
    var cached = getKey() && s && s.getItem(ME);
    if (cached) {
      try {
        var c = JSON.parse(cached);
        if (c.key === getKey() && Date.now() - c.at < 5 * 60 * 1000) return c.me;
      } catch (e) {}
    }
    var m = await api("/me");
    if (s && getKey()) s.setItem(ME, JSON.stringify({ key: getKey(), at: Date.now(), me: m }));
    return m;
  }

  function can(m, scope) {
    return !!(m && m.scopes && m.scopes.indexOf(scope) >= 0);
  }

  async function renderAccount() {
    var box = d.getElementById("dw-account");
    if (!box) return null;
    if (!authed()) return null;
    try {
      var m = await me();
      if (m.principal !== "member") return null;
      clear(box);
      var who = (m.member && (m.member.email || m.member.name)) || "Signed in";
      add(
        box,
        h("span", { class: "who", title: (m.member && m.member.role) || "", text: who }),
        h("button", {
          type: "button",
          class: "dw-btn small",
          text: "Sign out",
          onclick: signOut,
        }),
      );
      return m;
    } catch (e) {
      return null;
    }
  }

  function requireAuth() {
    if (authed()) return true;
    location.replace(signInHref(location.pathname + location.search));
    return false;
  }

  /** Buttons with data-copy="#id" copy that element's text; data-copy-text copies the attribute. */
  function wireCopyButtons(root) {
    $$("[data-copy],[data-copy-text]", root).forEach(function (b) {
      b.hidden = false;
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-copy-text");
        if (t === null) {
          var el = $(b.getAttribute("data-copy"));
          t = el ? el.textContent : "";
        }
        copyText(t, b);
      });
    });
  }

  /** <div role="tablist"> with buttons aria-controls=panel ids. */
  function wireTabs(root) {
    $$("[role=tablist]", root).forEach(function (list) {
      var tabs = $$("[role=tab]", list);
      function select(tab) {
        tabs.forEach(function (t) {
          var on = t === tab;
          t.setAttribute("aria-selected", on ? "true" : "false");
          t.tabIndex = on ? 0 : -1;
          var p = d.getElementById(t.getAttribute("aria-controls"));
          if (p) p.hidden = !on;
        });
      }
      tabs.forEach(function (t, i) {
        t.addEventListener("click", function () {
          select(t);
        });
        t.addEventListener("keydown", function (e) {
          var j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
          if (j < 0 && e.key !== "ArrowLeft") return;
          var n = tabs[(j + tabs.length) % tabs.length];
          n.focus();
          select(n);
        });
      });
    });
  }

  // ------------------------------------------------------------------ publisher (drag and drop)

  var IGNORE_SEGMENTS = [".git", "node_modules", "__MACOSX", ".svn", ".hg"];
  var IGNORE_NAMES = [".DS_Store", "Thumbs.db", "desktop.ini"];

  function ignored(path) {
    var segs = path.split("/");
    var name = segs[segs.length - 1];
    if (IGNORE_NAMES.indexOf(name) >= 0) return "system file";
    if (name === ".env" || name.indexOf(".env.") === 0) return "may contain secrets";
    for (var i = 0; i < segs.length - 1; i++) if (IGNORE_SEGMENTS.indexOf(segs[i]) >= 0) return segs[i] + " folder";
    return null;
  }

  /** If every path starts with the same folder, drop it (dropping "dist" publishes its contents). */
  function stripCommonRoot(items) {
    if (!items.length) return items;
    var first = items[0].path.split("/")[0];
    for (var i = 0; i < items.length; i++) {
      var p = items[i].path;
      if (p.indexOf("/") < 0 || p.split("/")[0] !== first) return items;
    }
    return items.map(function (it) {
      return Object.assign({}, it, { path: it.path.slice(first.length + 1) });
    });
  }

  /**
   * Read one DataTransfer entry into `out`. Unreadable files and directories are
   * reported into `errors` ({ path, kind }) instead of resolving silently, so a
   * partial traversal can never publish as if it were complete.
   */
  function readEntry(entry, prefix, out, errors) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(
          function (f) {
            out.push({ path: prefix + f.name, file: f });
            resolve();
          },
          function () {
            errors.push({ path: prefix + entry.name, kind: "file" });
            resolve();
          },
        );
      } else if (entry.isDirectory) {
        var dirPath = prefix + entry.name;
        var reader = entry.createReader();
        var all = [];
        var next = function () {
          reader.readEntries(
            function (batch) {
              if (!batch.length) {
                Promise.all(
                  all.map(function (e) {
                    return readEntry(e, dirPath + "/", out, errors);
                  }),
                ).then(function () {
                  resolve();
                });
                return;
              }
              all = all.concat(Array.prototype.slice.call(batch));
              next();
            },
            function () {
              errors.push({ path: dirPath, kind: "directory" });
              resolve();
            },
          );
        };
        next();
      } else resolve();
    });
  }

  async function filesFromDrop(dt) {
    var entries = [];
    if (dt.items) {
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        var en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (en) entries.push(en);
      }
    }
    if (!entries.length) {
      return {
        items: Array.prototype.map.call(dt.files || [], function (f) {
          return { path: f.name, file: f };
        }),
        errors: [],
      };
    }
    var out = [];
    var errors = [];
    await Promise.all(
      entries.map(function (e) {
        return readEntry(e, "", out, errors);
      }),
    );
    return { items: out, errors: errors };
  }

  async function sha256Hex(file) {
    var buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    var b = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  async function pool(items, size, fn) {
    var i = 0;
    var workers = [];
    for (var w = 0; w < Math.min(size, items.length); w++) {
      workers.push(
        (async function () {
          while (i < items.length) {
            var idx = i++;
            await fn(items[idx], idx);
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  async function putBlob(item, file, key) {
    var lastErr = null;
    for (var attempt = 0; attempt < 4; attempt++) {
      var res;
      try {
        res = await fetch(localPath(item.url), {
          method: "PUT",
          headers: Object.assign(key ? { Authorization: "Bearer " + key } : {}, { "Content-Type": (item.headers && item.headers["Content-Type"]) || "application/octet-stream", "X-Kofra-Client": "dashboard/1" }),
          body: file,
        });
      } catch (e) {
        lastErr = apiError(0, null, "Upload of " + item.paths[0] + " failed: network error.");
        await new Promise(function (r) {
          setTimeout(r, 600 * (attempt + 1));
        });
        continue;
      }
      if (res.ok) return;
      var data = null;
      try {
        data = await res.json();
      } catch (e) {}
      lastErr = apiError(res.status, data, "Upload of " + item.paths[0] + " failed.");
      if (res.status !== 429 && res.status < 500) throw lastErr;
      await new Promise(function (r) {
        setTimeout(r, 800 * (attempt + 1));
      });
    }
    throw lastErr;
  }

  /**
   * Mount the publish form in `root`.
   * opts.compact: home page version. opts.site: preselected existing site.
   */
  function mountPublisher(root, opts) {
    opts = opts || {};
    var key = getKey();
    var anonymous = !authed() && boot.anonymousPublish;
    clear(root);
    if (!authed() && !anonymous) {
      add(
        root,
        h(
          "div",
          { class: "dw-drop" },
          h("strong", { text: "Sign in to publish from the browser" }),
          h("p", { class: "dw-muted dw-small", text: "This instance publishes with API keys. Agents use the API, CLI or MCP below." }),
          h("a", { class: "dw-btn primary", href: signInHref(location.pathname), text: "Sign in" }),
        ),
      );
      return;
    }
    // errors: unreadable files/directories from the last traversal (publishing
    // blocked until reselected). seq: selection generation; a drop that resolves
    // after a newer selection (or after a publish started) is stale and ignored.
    var state = { items: [], skipped: [], errors: [], busy: false, seq: 0 };
    // Review navigation (search, visibility, ordering). Presentation only: it
    // never touches state.items, state.skipped, the ignore policy or what
    // run() sends. Every setItems call resets it to the complete review.
    var nav = { q: "", cat: "all", order: "path" };
    var navEls = null;
    // Explicit update destination (opts.site, or the slug lookup below). The
    // sites list is only its first page, so a nonempty explicit destination
    // is verified with the existing single-site GET and the slug it returns
    // is what gets selected and published to. destSeq fences races: every
    // newer explicit choice (a lookup, a picker change, new-site focus, a
    // finished publish) invalidates older in-flight lookups, whose late
    // responses are ignored. While destState is "pending" or "failed" the
    // update destination is unresolved and publishing stays disabled; it
    // never falls back to the first listed site or to a new site.
    var destSeq = 0;
    var destState = "idle"; // idle | pending | resolved | failed
    var destSite = null; // { slug, title } returned by the verifying GET
    var initialSite = opts.site && String(opts.site).trim() ? String(opts.site).trim() : null;
    var siteSelect = h("select", { class: "dw-select", id: "dw-pub-site", "aria-label": "Site to update" }, h("option", { value: "", text: "Loading sites…" }));
    var lookupInput = h("input", { class: "dw-input", id: "dw-pub-lookup", "aria-label": "Site slug to look up", placeholder: "exact site slug", autocomplete: "off", spellcheck: "false", style: "flex:1 1 10rem;width:auto;min-width:0" });
    var lookupBtn = h("button", { type: "button", class: "dw-btn", text: "Look up site" });
    var destStatus = h("div", { class: "dw-small dw-muted", role: "status" });
    var destError = h("div", { hidden: true });
    var slugInput = h("input", { class: "dw-input", id: "dw-pub-slug", placeholder: "generated if empty", autocomplete: "off", spellcheck: "false", pattern: "[a-z0-9][a-z0-9-]{1,62}" });
    var modeNew = h("input", { type: "radio", name: "dw-pub-mode", value: "new", checked: !opts.site });
    var modeUpd = h("input", { type: "radio", name: "dw-pub-mode", value: "update", checked: !!opts.site });
    var message = h("input", { class: "dw-input", id: "dw-pub-msg", maxlength: "200", placeholder: "What changed (optional)" });
    var dirInput = h("input", { type: "file", webkitdirectory: true, multiple: true, hidden: true });
    var fileInput = h("input", { type: "file", multiple: true, hidden: true });
    var summary = h("div", { class: "dw-small dw-muted", "aria-live": "polite" });
    var publishBtn = h("button", { type: "button", class: "dw-btn primary", text: "Publish", disabled: true });
    var clearBtn = h("button", { type: "button", class: "dw-btn ghost", text: "Clear", hidden: true });
    var status = h("div", { class: "dw-small", "aria-live": "polite" });
    var bar = h("span");
    var progress = h("div", { class: "dw-progress", hidden: true, role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, bar);
    var result = h("div");
    var errorList = h("div", { hidden: true });
    var review = h("details", { class: "dw-review", hidden: true });
    var chooseDirBtn = h("button", { type: "button", class: "dw-btn", text: "Choose folder", onclick: function (e) { e.stopPropagation(); dirInput.click(); } });
    var chooseFileBtn = h("button", { type: "button", class: "dw-btn", text: "Choose files", onclick: function (e) { e.stopPropagation(); fileInput.click(); } });
    var zone = h(
      "div",
      { class: "dw-drop", tabindex: "0", role: "button", "aria-label": "Drop a folder, files or a zip here, or press Enter to choose a folder" },
      h("strong", { text: "Drop a folder, files or a .zip" }),
      h("p", { class: "dw-muted dw-small", style: "margin:.25rem 0 .9rem", text: "Files are hashed in your browser; only files the server does not have yet are uploaded." }),
      h("div", { class: "dw-row", style: "justify-content:center" }, chooseDirBtn, chooseFileBtn),
      dirInput,
      fileInput,
    );

    /** Render one unreadable traversal entry. Ignored files never land here. */
    function traversalAlert(er) {
      return h(
        "div",
        { class: "dw-error", role: "alert" },
        h("strong", { text: (er.kind === "directory" ? "Could not read folder “" : "Could not read file “") + er.path + "”." }),
        h("div", { class: "dw-small", text: "Check access to this path, then reselect the folder, or use Choose files to select only the files you want to publish. Publishing stays disabled until the selection is complete." }),
      );
    }

    /** One review row per path (never a joined line), so narrow screens can wrap. */
    function reviewRow(text) {
      return h("li", { class: "dw-review-row" }, h("code", { class: "dw-mono", text: text }));
    }

    function setItems(items, errors) {
      // Normalize the whole selection before applying the existing ignore rules,
      // including unreadable paths. A directory's slash marks its subtree; an
      // unreadable sole root normalizes to "" and remains a blocking error.
      var selection = items.concat((errors || []).map(function (er) {
        return { path: er.path + (er.kind === "directory" ? "/" : ""), error: er };
      }));
      errors = [];
      var keep = [];
      var skipped = [];
      var skipRows = [];
      stripCommonRoot(selection).forEach(function (it) {
        var why = ignored(it.path);
        if (why) {
          var entry = it.path + " (" + why + (it.error ? "; " + (it.error.kind === "directory" ? "contents unreadable" : "unreadable") : "") + ")";
          skipped.push(entry);
          // The full "path (reason)" text stays the row; the path alone
          // drives review search and ordering, never the reason.
          skipRows.push({ path: it.path, text: entry });
        } else if (it.error) errors.push(it.error);
        else keep.push(it);
      });
      state.items = keep;
      state.skipped = skipped;
      state.errors = errors;
      clear(result);
      clear(errorList);
      errors.forEach(function (er) {
        add(errorList, traversalAlert(er));
      });
      errorList.hidden = !errors.length;
      var total = keep.reduce(function (s, it) {
        return s + it.file.size;
      }, 0);
      var zip = keep.length === 1 && /\.zip$/i.test(keep[0].path);
      var hasIndex = keep.some(function (it) {
        return /^(index\.html?|index\.md|readme\.md)$/i.test(it.path);
      });
      clear(summary);
      if (keep.length) {
        // The one-line display names the selection being sent (bounded: the
        // review below holds the complete inventory). It must keep describing
        // the in-flight publish while busy, so setItems never runs then.
        var preview = keep
          .slice(0, 3)
          .map(function (it) {
            return it.path;
          })
          .join(", ");
        if (keep.length > 3) preview += " + " + (keep.length - 3) + " more in the review";
        add(
          summary,
          h("span", { style: "color:var(--fg);font-weight:600", text: zip ? "1 zip file · " + bytes(total) + " (unpacked on the server)" : plural(keep.length, "file") + " · " + bytes(total) }),
          !zip && keep.length > 1 ? (hasIndex ? " · has an index page" : " · no index.html: the site root will list the files") : "",
          h("div", { text: preview }),
          skipped.length ? h("div", { text: "Skipped " + plural(skipped.length, "file") + ": " + skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? ", +" + (skipped.length - 5) + " more in the review" : "") }) : null,
        );
      } else if (skipped.length) add(summary, "Every file was skipped: " + skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? ", +" + (skipped.length - 5) + " more in the review" : ""));
      // The review lists the exact normalized inventory publish() will send:
      // every included path with its byte size, every excluded path with its
      // ignore reason. It reads no file contents and makes no requests.
      // Navigation (search, visibility, ordering) only re-renders these rows:
      // default is the complete review in deterministic Path order, included
      // group first. Size orders included bytes descending (equal sizes fall
      // back to Path order); exclusions always stay Path-ordered last, and an
      // unreadable exclusion keeps its "unreadable" note instead of a guessed
      // size. Hidden rows are still uploaded; Clear restores the full review.
      var wasOpen = review.open;
      clear(review);
      nav.q = "";
      nav.cat = "all";
      nav.order = "path";
      navEls = null;
      if (!keep.length && !skipped.length) {
        review.hidden = true;
      } else {
        review.hidden = false;
        var label = keep.length ? "Review " + plural(keep.length, "file") + " · " + bytes(total) : "Review selection";
        if (skipped.length) label += " · " + plural(skipped.length, "excluded file");
        add(review, h("summary", { text: label }));
        var search = h("input", { class: "dw-input", type: "search", placeholder: "Search paths", "aria-label": "Search review by path", autocomplete: "off", spellcheck: "false" });
        var navOption = function (value, text) {
          var o = h("option", { text: text });
          o.value = value;
          o.setAttribute("value", value);
          return o;
        };
        var catSel = h("select", { class: "dw-select", "aria-label": "Review visibility" }, navOption("all", "All"), navOption("included", "Included"), navOption("excluded", "Excluded"));
        catSel.value = "all";
        var orderSel = h("select", { class: "dw-select", "aria-label": "Review order" }, navOption("path", "Path"), navOption("size", "Size"));
        orderSel.value = "path";
        var clearNav = h("button", { type: "button", class: "dw-btn small", text: "Clear filters" });
        var counts = h("p", { class: "dw-small dw-muted", role: "status" });
        // Controls stay mounted while typing: only the emitted tail (headings,
        // lists, notes) is re-rendered, so focus never detaches mid-query.
        var tail = [];
        add(review, h("div", { class: "dw-review-nav" }, search, catSel, orderSel, clearNav));
        add(review, h("p", { class: "dw-small dw-muted", text: keep.length ? "Search, visibility and ordering only change this review. All included files are uploaded." : "Search, visibility and ordering only change this review." }));
        add(review, counts);
        var cmpPath = function (a, b) {
          return a < b ? -1 : a > b ? 1 : 0;
        };
        var renderReview = function () {
          var q = nav.q;
          var showIncluded = nav.cat !== "excluded";
          var showExcluded = nav.cat !== "included";
          var visKeep = showIncluded
            ? keep.filter(function (it) {
                return !q || it.path.toLowerCase().indexOf(q) >= 0;
              })
            : [];
          var visSkip = showExcluded
            ? skipRows.filter(function (r) {
                return !q || r.path.toLowerCase().indexOf(q) >= 0;
              })
            : [];
          // Sorted copies only: the normalized inventory keeps selection
          // order, which is the manifest order run() sends.
          var byPath = function (a, b) {
            return cmpPath(a.path, b.path);
          };
          visSkip.sort(byPath);
          if (nav.order === "size") {
            visKeep.sort(function (a, b) {
              return b.file.size - a.file.size || cmpPath(a.path, b.path);
            });
          } else {
            visKeep.sort(byPath);
          }
          counts.textContent = visKeep.length + " of " + keep.length + " included files · " + visSkip.length + " of " + skipRows.length + " excluded paths";
          tail.forEach(function (n) {
            n.remove();
          });
          tail = [];
          var emit = function (n) {
            add(review, n);
            tail.push(n);
          };
          if (visKeep.length) {
            emit(h("p", { class: "dw-small dw-muted dw-review-h", text: zip ? "Archive" : "Included (" + keep.length + ")" }));
            var included = h("ul", { class: "dw-review-list" });
            visKeep.forEach(function (it) {
              add(included, h("li", { class: "dw-review-row" }, h("code", { class: "dw-mono", text: it.path }), " · " + bytes(it.file.size)));
            });
            emit(included);
            if (zip) emit(h("p", { class: "dw-small dw-muted", text: "This archive is unpacked by the server; its entries cannot be listed before upload." }));
          }
          if (visSkip.length) {
            emit(h("p", { class: "dw-small dw-muted dw-review-h", text: "Excluded (" + skipRows.length + ")" }));
            var excluded = h("ul", { class: "dw-review-list" });
            visSkip.forEach(function (r) {
              add(excluded, reviewRow(r.text));
            });
            emit(excluded);
          }
          if (!visKeep.length && !visSkip.length) emit(h("p", { class: "dw-small dw-muted", text: "No matching files in this review." }));
        };
        search.addEventListener("input", function () {
          if (state.busy) return;
          // Literal substring on the path only: never a regex, never the
          // exclusion reason.
          nav.q = search.value.trim().toLowerCase();
          renderReview();
        });
        catSel.addEventListener("change", function () {
          if (state.busy) return;
          nav.cat = catSel.value;
          renderReview();
        });
        orderSel.addEventListener("change", function () {
          if (state.busy) return;
          nav.order = orderSel.value;
          renderReview();
        });
        clearNav.addEventListener("click", function () {
          if (state.busy) return;
          nav.q = "";
          nav.cat = "all";
          nav.order = "path";
          search.value = "";
          catSel.value = "all";
          orderSel.value = "path";
          renderReview();
          search.focus();
        });
        navEls = { search: search, cat: catSel, order: orderSel, clear: clearNav };
        if (state.busy) setNavDisabled(true);
        renderReview();
        review.open = wasOpen;
      }
      refreshPublishBtn();
      clearBtn.hidden = !keep.length;
    }

    function busyNotice() {
      toast("A publish is in progress. The new selection was ignored; try again when it finishes.", false);
    }
    zone.addEventListener("click", function () {
      if (state.busy) return;
      dirInput.click();
    });
    zone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (state.busy) return;
        dirInput.click();
      }
    });
    ["dragenter", "dragover"].forEach(function (t) {
      zone.addEventListener(t, function (e) {
        e.preventDefault();
        zone.classList.add("over");
      });
    });
    ["dragleave", "drop"].forEach(function (t) {
      zone.addEventListener(t, function () {
        zone.classList.remove("over");
      });
    });
    zone.addEventListener("drop", async function (e) {
      e.preventDefault();
      if (state.busy) {
        busyNotice();
        return;
      }
      var ticket = ++state.seq;
      var found = await filesFromDrop(e.dataTransfer);
      // A newer selection arrived (or a publish started) while enumerating:
      // the stale result must not replace the displayed selection.
      if (state.busy) {
        busyNotice();
        return;
      }
      if (ticket !== state.seq) return;
      setItems(found.items, found.errors);
    });
    dirInput.addEventListener("change", function () {
      var picked = Array.prototype.map.call(dirInput.files, function (f) {
        return { path: f.webkitRelativePath || f.name, file: f };
      });
      dirInput.value = "";
      if (state.busy) {
        busyNotice();
        return;
      }
      state.seq++;
      setItems(picked, []);
    });
    fileInput.addEventListener("change", function () {
      var picked = Array.prototype.map.call(fileInput.files, function (f) {
        return { path: f.name, file: f };
      });
      fileInput.value = "";
      if (state.busy) {
        busyNotice();
        return;
      }
      state.seq++;
      setItems(picked, []);
    });
    clearBtn.addEventListener("click", function () {
      if (state.busy) return;
      state.seq++;
      setItems([]);
      clear(status);
      progress.hidden = true;
    });

    function setProgress(fraction, text) {
      progress.hidden = false;
      var pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      bar.style.width = pct + "%";
      progress.setAttribute("aria-valuenow", String(pct));
      status.textContent = text;
    }

    /** Review navigation locks with the destination while a publish runs. */
    function setNavDisabled(on) {
      if (!navEls) return;
      navEls.search.disabled = on;
      navEls.cat.disabled = on;
      navEls.order.disabled = on;
      navEls.clear.disabled = on;
    }

    /** Destination controls bound to the active publish; frozen while it runs. */
    function setDestinationDisabled(on) {
      modeNew.disabled = on;
      modeUpd.disabled = on;
      slugInput.disabled = on;
      siteSelect.disabled = on;
      lookupInput.disabled = on;
      lookupBtn.disabled = on;
      chooseDirBtn.disabled = on;
      chooseFileBtn.disabled = on;
      clearBtn.disabled = on;
    }

    async function run() {
      if (state.busy || !state.items.length || state.errors.length) return;
      // An unresolved explicit update must never publish to whatever the
      // picker happens to show (see the destination state above).
      if (!anonymous && modeUpd.checked && destUnresolved()) return;
      state.seq++;
      state.busy = true;
      publishBtn.disabled = true;
      setDestinationDisabled(true);
      setNavDisabled(true);
      clear(result);
      var auth = key;
      var claim = null;
      try {
        var updating = !anonymous && modeUpd.checked;
        var slug = updating ? siteSelect.value : slugInput.value.trim().toLowerCase();
        if (updating && !slug) throw apiError(400, null, "Choose the site to update.");
        var msg = message.value.trim() || undefined;
        var items = state.items;
        // One .zip: the server unpacks it (one-shot publish, up to its one-shot size limit).
        if (items.length === 1 && /\.zip$/i.test(items[0].path)) {
          setProgress(0.3, "Uploading " + items[0].path + "…");
          var q = slug ? "?slug=" + encodeURIComponent(slug) + (msg ? "&message=" + encodeURIComponent(msg) : "") : msg ? "?message=" + encodeURIComponent(msg) : "";
          var out = await api("/publish" + q, { method: "POST", body: items[0].file, headers: { "Content-Type": "application/zip" }, key: auth || null });
          setProgress(1, "Published.");
          showResult({ url: out.url, slug: out.slug, version: out.version, unchanged: out.unchanged, claimToken: out.claimToken, expiresAt: out.expiresAt });
          return;
        }
        var hashed = 0;
        var manifest = [];
        var bySha = {};
        setProgress(0, "Hashing files…");
        await pool(items, 4, async function (it) {
          var sha = await sha256Hex(it.file);
          manifest.push({ path: it.path, size: it.file.size, sha256: sha });
          bySha[sha] = it.file;
          hashed++;
          setProgress((hashed / items.length) * 0.2, "Hashing " + hashed + " of " + items.length + "…");
        });
        if (!updating) {
          var created = await api("/sites", { method: "POST", body: slug ? { slug: slug } : {}, key: auth || null });
          slug = created.site.slug;
          if (created.claimToken) {
            claim = created;
            auth = created.claimToken;
          }
        }
        setProgress(0.22, "Checking which files the server already has…");
        var dep = await api("/sites/" + encodeURIComponent(slug) + "/deploys", { method: "POST", body: { files: manifest, message: msg }, key: auth });
        if (dep.unchanged) {
          setProgress(1, "Nothing changed.");
          // Unchanged needs a live version, so it is reachable only when updating
          // an existing site (the new-site leg above just created an empty one).
          // Recover that site's authoritative URL with an authorized read.
          if (updating) await showUnchangedResult(slug, dep.deploy, auth);
          else showResult({ slug: slug, unchanged: true, version: dep.deploy });
          return;
        }
        var uploads = dep.uploads || [];
        var total = uploads.reduce(function (s, u) {
          return s + u.size;
        }, 0);
        var sent = 0;
        var done = 0;
        await pool(uploads, 4, async function (u) {
          await putBlob(u, bySha[u.sha256], auth);
          sent += u.size;
          done++;
          setProgress(0.25 + (total ? sent / total : 1) * 0.65, "Uploaded " + done + " of " + uploads.length + " new files (" + bytes(sent) + " of " + bytes(total) + ")…");
        });
        setProgress(0.95, uploads.length ? "Making it live…" : "All files were already stored. Making it live…");
        var fin = await api(localPath(dep.finalizeUrl), { method: "POST", key: auth, abs: true });
        setProgress(1, "Published " + plural(manifest.length, "file") + (uploads.length < manifest.length ? " (" + (manifest.length - uploads.length) + " reused)" : "") + ".");
        showResult({
          url: fin.url,
          slug: slug,
          version: fin.site && fin.site.currentVersion,
          warnings: fin.warnings,
          claimToken: claim && claim.claimToken,
          expiresAt: claim && claim.expiresAt,
        });
      } catch (e) {
        progress.hidden = true;
        status.textContent = "";
        add(result, errorBox(e, "Publish failed"));
      } finally {
        state.busy = false;
        setDestinationDisabled(false);
        setNavDisabled(false);
        refreshPublishBtn();
      }
    }

    function showResult(r, opts) {
      setItems([]);
      clear(result);
      var url = r.url || null;
      var linkRetry = null;
      if (r.linkUnavailable) {
        linkRetry = h("button", {
          type: "button",
          class: "dw-btn small",
          text: "Retry getting the link",
          onclick: function () {
            if (linkRetry.disabled || !r.onLinkRetry) return;
            linkRetry.disabled = true;
            linkRetry.textContent = "Retrying…";
            r.onLinkRetry();
          },
        });
      }
      add(
        result,
        h(
          "div",
          { class: "dw-callout", role: "status" },
          h("strong", { text: r.unchanged ? "Nothing changed: the live version already has exactly these files." : "Live" + (r.version && r.version.number ? " as v" + r.version.number : "") + "." }),
          url
            ? h("div", { class: "dw-secret" }, h("code", {}, h("a", { href: url, target: "_blank", rel: "noopener", text: url })), copyButton(url, "Copy URL"))
            : null,
          h(
            "div",
            { class: "dw-row" },
            url ? h("a", { class: "dw-btn", href: url, target: "_blank", rel: "noopener", text: "Open site" }) : null,
            h("a", { class: "dw-btn", href: "/v/" + encodeURIComponent(r.slug) + "/", text: "Browse files" }),
            key ? h("a", { class: "dw-btn", href: "/dashboard/sites/" + encodeURIComponent(r.slug), text: "Manage" }) : null,
          ),
          r.linkUnavailable
            ? h(
                "div",
                { class: "dw-small", style: "margin-top:.6rem" },
                h("p", { text: "The public link could not be retrieved. The publish itself succeeded — nothing changed and nothing was uploaded. Retrying only reads the site link again; it does not publish again." }),
                h("div", { class: "dw-row", style: "margin-top:.4rem" }, linkRetry),
              )
            : null,
          // No receipt without a usable link: it would record a public
          // identity with nowhere to open it.
          r.linkUnavailable ? null : receiptBlock(r),
          r.warnings && r.warnings.length
            ? h("ul", { class: "dw-small" }, r.warnings.map(function (w) {
                return h("li", { text: w.message });
              }))
            : null,
          r.claimToken
            ? h(
                "div",
                { class: "dw-small", style: "margin-top:.6rem" },
                "Anonymous site: it expires " + (r.expiresAt ? new Date(r.expiresAt).toLocaleString() : "soon") + ". Keep it with the claim token (shown once): ",
                h("div", { class: "dw-secret" }, h("code", { text: r.claimToken }), copyButton(r.claimToken, "Copy claim token")),
              )
            : null,
        ),
      );
      if (opts && opts.restoreFocus) {
        var nextAction = linkRetry || $("a.dw-btn", result);
        if (nextAction) nextAction.focus();
      }
      if (key && !(opts && opts.keepDestination)) {
        modeUpd.checked = true;
        slugInput.value = "";
        // The slug just published to is verified; keep it selected as the
        // update destination even if the refreshed first page omits it.
        destSeq++;
        destState = "resolved";
        destSite = { slug: r.slug, title: destSite && destSite.slug === r.slug ? destSite.title : null };
        clear(destError);
        destError.hidden = true;
        destStatus.textContent = "Resolved destination: " + r.slug;
        lookupInput.value = r.slug;
        loadSites(r.slug);
      }
    }

    function destUnresolved() {
      return destState === "pending" || destState === "failed";
    }

    function refreshPublishBtn() {
      publishBtn.disabled = !state.items.length || state.busy || !!state.errors.length || (modeUpd.checked && destUnresolved());
    }

    /** A deliberate newer destination choice supersedes any in-flight lookup. */
    function invalidateDest() {
      destSeq++;
      destState = "idle";
      destSite = null;
      clear(destError);
      destError.hidden = true;
      destStatus.textContent = "";
    }

    /** Add the verified site as an option unless the list already has it. */
    function ensureDestOption(site) {
      var found = false;
      Array.prototype.forEach.call(siteSelect.children, function (o) {
        if (o.value === site.slug) found = true;
      });
      if (!found) add(siteSelect, h("option", { value: site.slug, text: site.title ? site.title + " (" + site.slug + ")" : site.slug }));
    }

    function failDest(err) {
      destState = "failed";
      destSite = null;
      destStatus.textContent = "";
      var box = errorBox(err, "Could not look up that site");
      add(box, h("div", { class: "dw-small", text: "Check the slug and look it up again, or choose a site from the list. Nothing was published." }));
      add(destError, box);
      destError.hidden = false;
      refreshPublishBtn();
    }

    /**
     * Verify one explicit destination with the existing single-site GET.
     * The reference is encoded as exactly one path segment and the slug the
     * server returns (never the typed reference) is selected. Typing alone
     * never calls this; only the initial explicit destination, Enter in the
     * lookup field or the lookup button do.
     */
    async function lookupDest(reference) {
      var ref = String(reference === null || reference === undefined ? "" : reference).trim();
      if (!ref) {
        destStatus.textContent = "Enter a site slug to look up.";
        return;
      }
      if (!key || state.busy) return;
      var seq = ++destSeq;
      destState = "pending";
      destSite = null;
      modeUpd.checked = true;
      clear(destError);
      destError.hidden = true;
      destStatus.textContent = "Looking up site " + ref + "…";
      siteSelect.value = "";
      refreshPublishBtn();
      // URL parsing normalizes dot segments even after encodeURIComponent.
      // Reject them locally after retiring any older lookup's intent.
      if (/^\.+$/.test(ref)) {
        failDest(apiError(400, null, "That is not a site slug."));
        return;
      }
      var res;
      try {
        res = await api("/sites/" + encodeURIComponent(ref));
      } catch (e) {
        if (seq !== destSeq) return; // a newer choice superseded this lookup
        failDest(e);
        return;
      }
      if (seq !== destSeq) return;
      var site = res && res.site;
      if (!site || !site.slug) {
        failDest(apiError(0, null, "The server did not return that site."));
        return;
      }
      destSite = { slug: site.slug, title: site.title || null };
      destState = "resolved";
      ensureDestOption(destSite);
      siteSelect.value = destSite.slug;
      lookupInput.value = destSite.slug;
      destStatus.textContent = "Resolved destination: " + destSite.slug;
      refreshPublishBtn();
    }

    /**
     * Show an unchanged update with its live link. The unchanged deploy itself
     * returns the version identity but no URL, so read the site (get_site) with
     * the publish's own credentials and use only the authoritative URL it
     * returns — never its live-version pointer, which may have moved on, and
     * never a URL rebuilt from the slug. A failed or unusable read keeps the
     * successful "nothing changed" result and offers a retry of the read only.
     */
    async function showUnchangedResult(slug, version, auth, restoreFocus) {
      // A retry runs after run() has finished: hold the same in-flight locks
      // while it reads, so a new selection cannot race its result rendering.
      var holdBusy = !state.busy;
      if (holdBusy) {
        state.busy = true;
        publishBtn.disabled = true;
        setDestinationDisabled(true);
        setNavDisabled(true);
      }
      try {
        var url = null;
        try {
          var res = await api("/sites/" + encodeURIComponent(slug), { key: auth });
          url = publicReceiptUrl(res && res.site && res.site.url);
        } catch (e) {
          url = null;
        }
        if (url) {
          showResult({ slug: slug, unchanged: true, version: version, url: url }, { keepDestination: true, restoreFocus: restoreFocus });
          return;
        }
        showResult(
          {
            slug: slug,
            unchanged: true,
            version: version,
            linkUnavailable: true,
            onLinkRetry: function () {
              return showUnchangedResult(slug, version, auth, true);
            },
          },
          { keepDestination: true, restoreFocus: restoreFocus },
        );
      } finally {
        if (holdBusy) {
          state.busy = false;
          setDestinationDisabled(false);
          setNavDisabled(false);
          refreshPublishBtn();
        }
      }
    }

    async function loadSites(select) {
      if (!key) return;
      var listSeq = destSeq;
      try {
        var res = await api("/sites?limit=200");
        var current = siteSelect.value;
        var currentOption = siteSelect.options[siteSelect.selectedIndex];
        clear(siteSelect);
        if (!res.sites.length && !(destState === "resolved" && destSite)) add(siteSelect, h("option", { value: "", text: "No sites yet" }));
        res.sites.forEach(function (s) {
          add(siteSelect, h("option", { value: s.slug, text: s.title ? s.title + " (" + s.slug + ")" : s.slug }));
        });
        // A deliberate picker choice may be a previously verified off-page
        // option. Keep its label and identity before restoring its value.
        if (current && currentOption && !res.sites.some(function (s) { return s.slug === current; })) add(siteSelect, currentOption);
        // Decide the selection when the list lands, not when it was asked
        // for: a destination verified (or still resolving) meanwhile wins
        // over the stale select request and over the first listed site.
        if (destState === "resolved" && destSite) {
          ensureDestOption(destSite);
          siteSelect.value = destSite.slug;
        } else if (destUnresolved()) {
          siteSelect.value = "";
        } else if (current && destSeq !== listSeq) {
          // A newer explicit choice (e.g. the picker) landed while this
          // list was in flight; the older list response must not move it.
          siteSelect.value = current;
        } else if (select) {
          siteSelect.value = select;
        } else if (current) {
          siteSelect.value = current;
        }
      } catch (e) {
        clear(siteSelect);
        if (destState === "resolved" && destSite) {
          ensureDestOption(destSite);
          siteSelect.value = destSite.slug;
        } else {
          add(siteSelect, h("option", { value: "", text: "Could not load sites" }));
        }
      }
    }

    publishBtn.addEventListener("click", run);
    var target = anonymous
      ? h("p", { class: "dw-small dw-muted", text: "You are not signed in: this instance allows anonymous sites. They expire unless claimed with an API key." })
      : h(
          "fieldset",
          { style: "border:0;padding:0;margin:0 0 .9rem" },
          h("legend", { class: "dw-label", text: "Publish to" }),
          h("div", { class: "dw-grid2" },
            h("label", { class: "dw-check" }, modeNew, h("span", {}, "A new site", h("span", { class: "dw-sub" }, "Name (optional)"), slugInput)),
            h(
              "label",
              { class: "dw-check" },
              modeUpd,
              h(
                "span",
                { style: "flex:1" },
                "A new version of",
                h("span", { class: "dw-sub" }, "Site"),
                siteSelect,
                h("span", { class: "dw-sub" }, "Site slug (if it is not in the list)"),
                h("div", { class: "dw-row" }, lookupInput, lookupBtn),
                h("p", { class: "dw-help", text: "The list shows recent sites only. To update an older site, enter its exact slug and look it up; the verified site becomes the destination." }),
                destStatus,
                destError,
              ),
            ),
          ),
        );
    slugInput.addEventListener("focus", function () {
      modeNew.checked = true;
      invalidateDest();
      refreshPublishBtn();
    });
    siteSelect.addEventListener("change", function () {
      modeUpd.checked = true;
      invalidateDest();
      refreshPublishBtn();
    });
    modeNew.addEventListener("change", function () {
      invalidateDest();
      refreshPublishBtn();
    });
    modeUpd.addEventListener("change", function () {
      refreshPublishBtn();
    });
    lookupInput.addEventListener("focus", function () {
      modeUpd.checked = true;
      refreshPublishBtn();
    });
    lookupInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        lookupDest(lookupInput.value);
      }
    });
    lookupBtn.addEventListener("click", function () {
      lookupDest(lookupInput.value);
    });
    add(
      root,
      target,
      opts.compact ? null : h("div", { class: "dw-field" }, h("label", { class: "dw-label", for: "dw-pub-msg", text: "Message" }), message),
      zone,
      h("div", { class: "dw-row", style: "justify-content:space-between;margin-top:.75rem" }, summary, h("div", { class: "dw-row" }, clearBtn, publishBtn)),
      errorList,
      review,
      progress,
      status,
      result,
    );
    if (key) {
      loadSites(opts.site);
      // Verify an explicit destination independently of (and without
      // waiting for) the first list page above.
      if (initialSite) lookupDest(initialSite);
    }
  }

  // ------------------------------------------------------------------ QR encoder (vendored)
  //
  // Matrix core of QR Code Generator for JavaScript (qrcode-generator 2.0.4),
  // Copyright (c) 2009 Kazuhiko Arase, MIT license. Renderers (table, SVG,
  // GIF, ASCII, canvas), the GIF writer, the SJIS helper and the UMD wrapper
  // are stripped: the dashboard needs only addData/make/isDark/getModuleCount
  // in byte mode, and draws the modules to its own canvas, so no image
  // endpoint or third-party request is needed at runtime.
  //
  // MIT License permission notice: Permission is hereby granted, free of
  // charge, to any person obtaining a copy of this software and associated
  // documentation files (the "Software"), to deal in the Software without
  // restriction, including without limitation the rights to use, copy, modify,
  // merge, publish, distribute, sublicense, and/or sell copies of the Software,
  // and to permit persons to whom the Software is furnished to do so, subject
  // to the following conditions: The above copyright notice and this permission
  // notice shall be included in all copies or substantial portions of the
  // Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
  // EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  // MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
  // NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
  // DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
  // OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
  // USE OR OTHER DEALINGS IN THE SOFTWARE.
  var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

  return qrcode;
}();

  // ------------------------------------------------------------------ site QR code
  //
  // The site page shows a QR code that opens the live site on a phone. The
  // matrix comes from the vendored encoder above and is drawn to a canvas, so
  // the PNG data URL is generated entirely client-side: no new endpoint, no
  // image service, no third-party request, and no CSP change (img-src data:
  // is already allowed). The payload is always the site's clean public live
  // URL exactly as the API returned it; a password-gated site gets the same
  // payload plus a notice, and the password itself is never touched here.

  /** PNG data URL of the QR matrix for `text` (auto version, ECC M, quiet zone 4). */
  function qrPngDataURL(text) {
    var qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    var count = qr.getModuleCount();
    var cell = 8;
    var quiet = 4;
    var size = (count + quiet * 2) * cell;
    var canvas = d.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2d is unavailable.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
    return canvas.toDataURL("image/png");
  }

  /** "Open on your phone" section for the site page: QR + adjacent URL, or a state. */
  function siteQrSection(url, gated) {
    var head = h("header", {}, h("h2", { text: "Open on your phone" }));
    if (!url) {
      return h(
        "section",
        { class: "dw-section" },
        head,
        h("div", { class: "dw-pad" }, h("p", { "data-testid": "site-qr-empty", style: "margin:0", text: "No live URL yet, so there is no QR code. Publish a version and the code appears here." })),
      );
    }
    var img;
    try {
      img = h("img", {
        class: "dw-qr-img",
        "data-testid": "site-qr-image",
        src: qrPngDataURL(url),
        alt: url,
        "data-qr-payload": url,
        style: "width:12rem;max-width:100%;height:auto;background:#ffffff;border:1px solid var(--line);border-radius:var(--radius)",
      });
    } catch (e) {
      return h(
        "section",
        { class: "dw-section" },
        head,
        h("div", { class: "dw-pad" }, h("div", { class: "dw-error", role: "alert", "data-testid": "site-qr-error", text: "The QR code could not be generated in this browser." })),
      );
    }
    return h(
      "section",
      { class: "dw-section", "data-testid": "site-qr" },
      h("header", {}, h("h2", { text: "Open on your phone" }), h("span", { class: "dw-small dw-muted", text: "Scan with your phone camera" })),
      h(
        "div",
        { class: "dw-pad dw-row", style: "align-items:flex-start;gap:1rem" },
        img,
        h(
          "div",
          { style: "min-width:0" },
          h("p", { "data-testid": "site-qr-url", style: "margin:0 0 .5rem;overflow-wrap:anywhere" }, h("a", { href: url, target: "_blank", rel: "noopener", text: url }), " ", copyButton(url, "Copy site URL")),
          gated ? h("p", { class: "dw-small", "data-testid": "site-qr-gated-notice", style: "margin:0", text: "Visitors need the site password after scanning." }) : null,
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ pages

  var pages = {};
  // Latest site-page traversal handler: pages.site() re-runs after restore,
  // delete and settings saves, and must replace (not stack) its listener.
  var sitePopstate = null;
  // Generation of the latest pages.site() run: work started by an earlier
  // run must not commit (view, URL or history) over its replacement.
  var siteRun = 0;

  pages.home = async function () {
    wireTabs(d);
    var m = await renderAccount();
    var cta = d.getElementById("dw-home-cta");
    if (cta && m) {
      clear(cta);
      add(cta, h("a", { class: "dw-btn primary", href: "/dashboard", text: "Open dashboard" }), h("a", { class: "dw-btn", href: "/dashboard/keys", text: "API keys" }));
    }
    var quick = d.getElementById("dw-quick");
    if (quick) mountPublisher(quick, { compact: true });
    // Fill the user's own key into snippets? Never: keys stay out of the page.
  };

  pages.login = async function () {
    var params = new URLSearchParams(location.search);
    var next = safeNext(params.get("next"));
    var note = d.getElementById("dw-login-note");
    if (note && params.get("expired")) add(note, errorBox({ message: "Your key was rejected (revoked or expired). Sign in again." }));
    if (note && params.get("signedout")) add(note, h("div", { class: "dw-callout", role: "status", text: "Signed out. The key was removed from this browser." }));
    if (note && params.get("retry")) add(note, h("div", { class: "dw-callout", role: "status", text: "The page was still loading. Nothing was sent anywhere else; please sign in again." }));
    var form = d.getElementById("dw-signin");
    if (form) {
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var out = d.getElementById("dw-signin-out");
        clear(out);
        var k = form.elements.key.value.trim();
        if (!k) return;
        var btn = form.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          var m = await api("/me", { key: k });
          if (m.principal !== "member") {
            throw apiError(400, null, m.principal === "bootstrap" ? "That is the bootstrap secret, not an API key. Use it below to set up the instance or recover owner access." : "That is not a member API key.");
          }
          setKey(k, form.elements.remember.checked);
          location.href = next;
        } catch (err) {
          add(out, errorBox(err, "Sign-in failed"));
        } finally {
          btn.disabled = false;
        }
      });
    }
    function bootstrapForm(id, path, bodyFn, label) {
      var f = d.getElementById(id);
      if (!f) return;
      f.addEventListener("submit", async function (e) {
        e.preventDefault();
        var out = f.querySelector(".dw-out");
        clear(out);
        var btn = f.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          var res = await api(path, { method: "POST", key: f.elements.secret.value.trim(), body: bodyFn(f) });
          var k = res.apiKey.key;
          f.elements.secret.value = "";
          // The job of this form is done: leave only the key and the way on.
          $$(".dw-field, .dw-grid2, button[type=submit]", f).forEach(function (x) {
            x.hidden = true;
          });
          add(
            out,
            secretBlock(label, k, "Shown once. Store it in your password manager; agents use it as Authorization: Bearer <key>."),
            h("button", {
              type: "button",
              class: "dw-btn primary",
              text: "I saved it. Continue",
              onclick: function () {
                setKey(k, false);
                location.href = "/dashboard";
              },
            }),
          );
        } catch (err) {
          add(out, errorBox(err));
        } finally {
          btn.disabled = false;
        }
      });
    }
    bootstrapForm(
      "dw-setup",
      "/setup",
      function (f) {
        return { email: f.elements.email.value.trim() || undefined, name: f.elements.name.value.trim() || undefined };
      },
      "Owner API key created",
    );
    bootstrapForm("dw-recover", "/setup/recover", function () {
      return undefined;
    }, "New owner API key");
  };

  function siteRow(s) {
    var v = s.currentVersion;
    var badges = [];
    if (s.settings && s.settings.passwordProtected) badges.push(h("span", { class: "dw-badge warn", text: "Password" }));
    if (s.settings && s.settings.spa) badges.push(h("span", { class: "dw-badge", text: "SPA" }));
    if (s.expiresAt) badges.push(h("span", { class: "dw-badge warn", title: s.expiresAt, text: "Expires " + new Date(s.expiresAt).toLocaleDateString() }));
    if (!v) badges.push(h("span", { class: "dw-badge", text: "Empty" }));
    return h(
      "tr",
      { "data-search": [s.slug, s.title || ""].join(" ").toLowerCase() },
      h(
        "td",
        {},
        h("a", { class: "dw-title", href: "/dashboard/sites/" + encodeURIComponent(s.slug), text: s.title || s.slug }),
        " ",
        badges,
        s.title ? h("span", { class: "dw-sub dw-mono", text: s.slug }) : null,
      ),
      h(
        "td",
        { class: "dw-hide-sm" },
        h("span", { class: "dw-url" }, h("a", { href: s.url, target: "_blank", rel: "noopener", class: "dw-small", text: s.url.replace(/^https?:\/\//, "") }), copyButton(s.url, "Copy URL of " + s.slug)),
      ),
      h("td", { class: "num dw-small" }, v ? "v" + v.number : "–", h("span", { class: "dw-sub", text: v ? plural(v.fileCount, "file") + " · " + bytes(v.totalBytes) : "" })),
      h("td", { class: "num dw-small dw-muted dw-hide-sm", title: s.updatedAt, text: ago(s.updatedAt) }),
      h(
        "td",
        { class: "act" },
        h("a", { class: "dw-btn small", href: "/v/" + encodeURIComponent(s.slug) + "/", text: "Files" }),
        " ",
        h("a", { class: "dw-btn small", href: s.url, target: "_blank", rel: "noopener", text: "Open" }),
      ),
    );
  }

  pages.sites = async function () {
    if (!requireAuth()) return;
    renderAccount();
    var root = d.getElementById("dw-sites");
    var count = d.getElementById("dw-sites-count");
    var search = h("input", { class: "dw-input", type: "search", placeholder: "Filter loaded sites by name or title", "aria-label": "Filter loaded sites" });
    var tbody = h("tbody");
    var more = h("button", { type: "button", class: "dw-btn", text: "Load more", hidden: true });
    var table = h(
      "div",
      { class: "dw-scroll" },
      h(
        "table",
        { class: "dw-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Site" }), h("th", { scope: "col", class: "dw-hide-sm", text: "URL" }), h("th", { scope: "col", class: "num", text: "Live" }), h("th", { scope: "col", class: "num dw-hide-sm", text: "Updated" }), h("th", { scope: "col" }))),
        tbody,
      ),
    );
    var body = h("div", {}, skeleton(4));
    var errorWrap = h("div", {});
    var moreWrap = h("div", { class: "dw-pad", style: "text-align:center", hidden: true }, more);
    clear(root);
    add(root, h("section", { class: "dw-section" }, h("header", {}, h("h2", { text: "All sites" }), search), body, errorWrap, moreWrap));
    var cursor = null;
    var loaded = 0;
    var seenSlugs = [];
    var consumedCursors = [];
    var loading = false;
    var hasMore = true;
    var tableShown = false;
    function currentQuery() {
      return search.value.trim().toLowerCase();
    }
    function updateCounts() {
      if (!count || !tableShown) return;
      var q = currentQuery();
      var visible = 0;
      $$("tr[data-search]", tbody).forEach(function (tr) {
        if (!tr.hidden) visible++;
      });
      if (q) {
        count.textContent = plural(visible, "match", "matches") + " of " + plural(loaded, "loaded site", "loaded sites") + (hasMore ? "+" : "") + ".";
      } else {
        count.textContent = plural(loaded, "site") + (hasMore ? "+" : "") + ".";
      }
    }
    function applyFilter() {
      var q = currentQuery();
      $$("tr[data-search]", tbody).forEach(function (tr) {
        var hay = tr.getAttribute("data-search") || "";
        tr.hidden = !!(q && hay.indexOf(q) < 0);
      });
      updateCounts();
    }
    function syncMore() {
      moreWrap.hidden = !hasMore;
      more.hidden = !hasMore;
      more.disabled = !hasMore;
      if (more.getAttribute("aria-busy")) more.removeAttribute("aria-busy");
      if (more.textContent !== "Load more") more.textContent = "Load more";
    }
    function emptySites() {
      return h(
        "div",
        { class: "dw-empty", role: "status" },
        h("h3", { text: "No sites yet" }),
        h("p", { text: "Publish a folder from this browser, or let an agent publish with the API, CLI or MCP." }),
        h("a", { class: "dw-btn primary", href: "/dashboard/publish", text: "Publish a folder" }),
      );
    }
    async function load() {
      if (loading) return;
      if (!hasMore) return;
      loading = true;
      var focusedBefore = d.activeElement === more;
      more.disabled = true;
      more.setAttribute("aria-busy", "true");
      more.textContent = "Loading…";
      var requestCursor = cursor;
      try {
        var res = await api("/sites?limit=100" + (requestCursor ? "&cursor=" + encodeURIComponent(requestCursor) : ""));
        if (consumedCursors.indexOf(requestCursor) < 0) consumedCursors.push(requestCursor);
        clear(errorWrap);
        if (!tableShown && !loaded && !res.sites.length) {
          clear(body);
          add(body, emptySites());
          if (count) count.textContent = "No sites yet.";
          var firstNext = res.nextCursor;
          if (firstNext && consumedCursors.indexOf(firstNext) < 0) {
            cursor = firstNext;
            hasMore = true;
          } else {
            cursor = null;
            hasMore = false;
          }
          syncMore();
          return;
        }
        if (!tableShown) {
          clear(body);
          add(body, table);
          tableShown = true;
        }
        res.sites.forEach(function (s) {
          if (seenSlugs.indexOf(s.slug) >= 0) return;
          seenSlugs.push(s.slug);
          tbody.appendChild(siteRow(s));
        });
        loaded = seenSlugs.length;
        var next = res.nextCursor;
        if (!next || consumedCursors.indexOf(next) >= 0) {
          cursor = null;
          hasMore = false;
        } else {
          cursor = next;
          hasMore = true;
        }
        applyFilter();
        syncMore();
      } catch (e) {
        clear(errorWrap);
        add(errorWrap, h("div", { class: "dw-pad" }, errorBox(e, "Could not load sites"), h("p", { class: "dw-small", text: "Use Load more to retry this page." })));
        if (!tableShown && !loaded) {
          clear(body);
          if (count) count.textContent = "Could not load sites.";
        }
        cursor = requestCursor;
        hasMore = true;
        syncMore();
        more.disabled = false;
      } finally {
        loading = false;
        if (focusedBefore && hasMore && (d.activeElement === d.body || d.activeElement === null)) {
          try {
            more.focus();
          } catch (focusErr) {}
        }
      }
    }
    search.addEventListener("input", function () {
      applyFilter();
    });
    more.addEventListener("click", load);
    load();
  };

  pages.site = async function () {
    if (!requireAuth()) return;
    var mySiteRun = ++siteRun;
    renderAccount();
    var slug = P.slug;
    var root = d.getElementById("dw-site");
    clear(root);
    add(
      root,
      skeleton(5),
      h("section", { class: "dw-section", "aria-busy": "true", "aria-label": "Loading QR code" }, h("div", { class: "dw-pad", "data-testid": "site-qr-loading", text: "Loading QR code…" })),
    );
    var site, versions, files, linkedVersion, linkedVersionError;
    var requestedVersion = new URL(location.href).searchParams.get("version");
    try {
      var r = await Promise.all([
        api("/sites/" + encodeURIComponent(slug)),
        api("/sites/" + encodeURIComponent(slug) + "/versions?limit=100"),
        requestedVersion ? api("/sites/" + encodeURIComponent(slug) + "/versions/" + encodeURIComponent(requestedVersion)).catch(function (error) {
          linkedVersionError = error;
          return null;
        }) : Promise.resolve(null),
      ]);
      site = r[0].site;
      versions = r[1].versions;
      linkedVersion = r[2] && r[2].version;
      // A newer re-run already owns this page; rendering now would replace it.
      if (mySiteRun !== siteRun) return;
    } catch (e) {
      if (mySiteRun !== siteRun) return;
      clear(root);
      add(
        root,
        errorBox(e, "Could not load " + slug),
        h("div", { class: "dw-section" }, h("div", { class: "dw-pad", role: "alert", "data-testid": "site-qr-error", text: "The QR code is unavailable because the site could not be loaded." })),
        h("a", { class: "dw-btn", href: "/dashboard", text: "Back to sites" }),
      );
      return;
    }
    d.title = (site.title || site.slug) + " · " + boot.instanceName;
    clear(root);
    var filesSection = h("section", { class: "dw-section", id: "files" });
    var duplicateAttempt = null;
    var duplicateDialog = null;
    var duplicateButton = h("button", { type: "button", class: "dw-btn", text: "Duplicate site", onclick: openDuplicate });
    function openDuplicate() {
      if (duplicateDialog) return;
      var busy = false;
      var destination = h("input", { class: "dw-input", id: "dw-duplicate-slug", name: "newSlug", required: true, minlength: "3", maxlength: "56", autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-describedby": "dw-duplicate-slug-help" });
      var message = h("textarea", { class: "dw-input", id: "dw-duplicate-message", name: "message", maxlength: "500", rows: "2" });
      var feedback = h("div", { "aria-live": "polite", style: "overflow-wrap:anywhere" });
      var submit = h("button", { type: "submit", class: "dw-btn primary", text: "Duplicate site" });
      var cancel = h("button", { type: "button", class: "dw-btn", text: "Cancel", onclick: function () { dlg.close(); } });
      var form = h(
        "form",
        {},
        h("h2", { id: "dw-duplicate-title", text: "Duplicate site" }),
        h("p", { id: "dw-duplicate-warning", class: "dw-callout", text: "This creates a separate site from the source's live files, live immediately. Passwords and access protection are not copied. Re-apply protection on the copy before sharing it. Only SPA mode is carried over; all other settings reset to instance defaults. The original site is unchanged." }),
        h("div", { class: "dw-field" },
          h("label", { class: "dw-label", for: "dw-duplicate-slug", text: "Destination slug" }), destination,
          h("p", { class: "dw-help", id: "dw-duplicate-slug-help", text: "3–56 lowercase letters, digits and single hyphens; start and end with a letter or digit. Choose an unused name." })),
        h("div", { class: "dw-field" }, h("label", { class: "dw-label", for: "dw-duplicate-message", text: "Version message (optional)" }), message),
        feedback,
        h("div", { class: "dw-row" }, cancel, submit),
      );
      var dlg = h("dialog", { class: "dw-dialog", "aria-labelledby": "dw-duplicate-title", "aria-describedby": "dw-duplicate-warning" }, form);
      duplicateDialog = dlg;
      dlg.addEventListener("cancel", function (event) {
        if (busy) event.preventDefault();
      });
      dlg.addEventListener("close", function () {
        dlg.remove();
        duplicateDialog = null;
        duplicateButton.focus();
      });
      // Native modal Tab handling still cycles through the browser UI, which
      // leaves focus on the page body between the last and first controls.
      // Keep the cycle among this dialog's enabled, tabbable controls instead.
      dlg.addEventListener("keydown", function (event) {
        if (event.key !== "Tab") return;
        var focusable = $$("a[href], button, input, textarea, select, [tabindex]", dlg).filter(function (el) {
          return !el.disabled && el.tabIndex >= 0;
        });
        if (!focusable.length) {
          event.preventDefault();
          return;
        }
        var active = d.activeElement;
        if (event.shiftKey && (active === focusable[0] || focusable.indexOf(active) < 0)) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        } else if (!event.shiftKey && (active === focusable[focusable.length - 1] || focusable.indexOf(active) < 0)) {
          event.preventDefault();
          focusable[0].focus();
        }
      });
      function setBusy(value) {
        busy = value;
        dlg.setAttribute("aria-busy", String(value));
        destination.disabled = message.disabled = submit.disabled = cancel.disabled = value;
        submit.textContent = value ? "Duplicating…" : "Duplicate site";
      }
      // An edit starts a new submission, even when the previous request's outcome
      // was unknown. Closing/reopening alone retains the last attempt for replay.
      function changed() { duplicateAttempt = null; }
      destination.addEventListener("input", changed);
      message.addEventListener("input", changed);
      if (duplicateAttempt) {
        destination.value = duplicateAttempt.body.newSlug;
        message.value = duplicateAttempt.body.message || "";
      }
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (busy) return;
        clear(feedback);
        var newSlug = destination.value;
        if (!/^[a-z0-9][a-z0-9-]{1,54}[a-z0-9]$/.test(newSlug) || newSlug.indexOf("--") >= 0) {
          add(feedback, errorBox({ message: "Enter a valid destination slug.", hint: "Use 3–56 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.", code: "invalid_slug" }));
          destination.focus();
          return;
        }
        if (message.value.length > 500) {
          add(feedback, errorBox({ message: "The version message is too long.", hint: "Use at most 500 characters.", code: "invalid_request" }));
          message.focus();
          return;
        }
        var body = { newSlug: newSlug };
        if (message.value) body.message = message.value;
        var signature = JSON.stringify(body);
        if (!duplicateAttempt || duplicateAttempt.signature !== signature) {
          duplicateAttempt = { signature: signature, body: body, key: crypto.randomUUID() };
        }
        setBusy(true);
        try {
          var result = await api("/sites/" + encodeURIComponent(site.slug) + "/duplicate", { method: "POST", body: duplicateAttempt.body, headers: { "Idempotency-Key": duplicateAttempt.key } });
          // Links and receipt use only the returned identity, never the requested name.
          var copy = result && result.site;
          var copyUrl = null;
          try { if (result && typeof result.url === "string") copyUrl = new URL(result.url); } catch (e) {}
          if (!copy || typeof copy.slug !== "string" || !copy.slug || !copyUrl || ["http:", "https:"].indexOf(copyUrl.protocol) < 0) throw new Error("The server did not return a valid copy identity and URL. Retry this submission to recover its result.");
          clear(form);
          add(form,
            h("h2", { id: "dw-duplicate-title", text: "Site duplicated" }),
            h("div", { role: "status", style: "overflow-wrap:anywhere" },
              h("p", { text: "Created a separate site: " + copy.slug }),
              h("p", {}, h("a", { href: result.url, target: "_blank", rel: "noopener", text: result.url }))),
            h("p", { id: "dw-duplicate-warning", class: "dw-callout", text: "Passwords and access protection were not copied. Re-apply protection before sharing the new site." }),
            h("div", { class: "dw-row" },
              h("button", { type: "button", class: "dw-btn", text: "Close", onclick: function () { dlg.close(); } }),
              h("a", { class: "dw-btn primary", href: "/dashboard/sites/" + encodeURIComponent(copy.slug), text: "Manage copy" })),
          );
          duplicateAttempt = null;
          $("button", form).focus();
        } catch (error) {
          add(feedback, errorBox(error, "Could not duplicate site"));
        } finally {
          setBusy(false);
        }
      });
      d.body.appendChild(dlg);
      dlg.showModal();
      destination.focus();
    }
    var head = h(
      "div",
      { class: "dw-pagehead" },
      h(
        "div",
        { style: "min-width:0" },
        h("h1", { class: "dw-h1", text: site.title || site.slug }),
        h("p", {}, h("span", { class: "dw-url" }, h("a", { href: site.url, target: "_blank", rel: "noopener", text: site.url }), copyButton(site.url, "Copy site URL"))),
        site.description ? h("p", { text: site.description }) : null,
      ),
      h(
        "div",
        { class: "dw-row" },
        h("a", { class: "dw-btn", href: "/v/" + encodeURIComponent(slug) + "/", text: "Browse files" }),
        h("a", { class: "dw-btn", href: "/dashboard/publish?site=" + encodeURIComponent(slug), text: "Publish update" }),
        duplicateButton,
        h("a", { class: "dw-btn primary", href: site.url, target: "_blank", rel: "noopener", text: "Open site" }),
      ),
    );

    // Mutations that reload this page must not detach another action's feedback.
    var siteMutationPending = false;
    function setSiteMutationPending(pending) {
      siteMutationPending = pending;
      $$("button[data-site-mutation]", root).forEach(function (button) {
        button.disabled = pending;
      });
    }
    var vBody = h("tbody");
    versions.forEach(function (v) {
      vBody.appendChild(
        h(
          "tr",
          { "data-search": ["v" + v.number, v.id, v.message || "", v.client || "", v.source || ""].join(" ").toLowerCase() },
          h("td", {}, h("strong", { text: "v" + v.number }), " ", v.live ? h("span", { class: "dw-badge live", text: "Live" }) : null),
          h("td", { class: "dw-small" }, v.message ? h("span", { text: v.message }) : h("span", { class: "dw-muted", text: "No message" }), h("span", { class: "dw-sub", text: [v.client, v.source].filter(Boolean).join(" · ") })),
          h("td", { class: "num dw-small" }, plural(v.fileCount, "file"), h("span", { class: "dw-sub", text: bytes(v.totalBytes) })),
          h("td", { class: "num dw-small dw-muted dw-hide-sm", title: v.finalizedAt || v.createdAt, text: ago(v.finalizedAt || v.createdAt) }),
          h(
            "td",
            { class: "act" },
            h("button", { type: "button", class: "dw-btn small", text: "Files", onclick: function () { showFiles(v, { history: "push", clearFirst: true }); filesSection.scrollIntoView({ behavior: "smooth" }); } }),
            " ",
            v.live
              ? null
              : h("button", {
                  type: "button",
                  class: "dw-btn small",
                  text: "Restore",
                  "data-site-mutation": "",
                  onclick: async function () {
                    if (siteMutationPending) return;
                    setSiteMutationPending(true);
                    try {
                      await api("/sites/" + encodeURIComponent(slug) + "/versions/" + encodeURIComponent(v.id) + "/restore", { method: "POST" });
                      toast("v" + v.number + " is live again.");
                      pages.site();
                    } catch (e) {
                      toast(e.message, true);
                    } finally {
                      setSiteMutationPending(false);
                    }
                  },
                }),
            " ",
            v.live
              ? null
              : h("button", {
                  type: "button",
                  class: "dw-btn small danger",
                  text: "Delete",
                  "aria-label": "Delete version " + v.number,
                  "data-site-mutation": "",
                  onclick: async function (ev) {
                    if (siteMutationPending) return;
                    var trigger = ev.currentTarget;
                    setSiteMutationPending(true);
                    try {
                      var ok = await confirmBox({ title: "Delete v" + v.number + "?", message: "The version and its file list are removed for good (use this for a version that leaked something). Other versions are not affected.", confirmText: "Delete version" });
                      if (!ok) return;
                      await api("/sites/" + encodeURIComponent(slug) + "/versions/" + encodeURIComponent(v.id), { method: "DELETE" });
                      toast("v" + v.number + " deleted.");
                      // A successful deletion must not reload its now-invalid
                      // explicit link; unrelated inspected versions stay put.
                      var url = new URL(location.href);
                      if (url.searchParams.get("version") === v.id) {
                        url.searchParams.delete("version");
                        history.replaceState(null, "", url.pathname + url.search + url.hash);
                      }
                      pages.site();
                    } catch (e) {
                      toast(e.message, true);
                    } finally {
                      setSiteMutationPending(false);
                      if ($$("button", root).indexOf(trigger) >= 0) trigger.focus();
                    }
                  },
                }),
          ),
        ),
      );
    });
    var versionFilter = h("input", { id: "dw-version-filter", class: "dw-input", type: "search", placeholder: "Version, id, message, client or source", "aria-describedby": "dw-version-scope", style: "flex:1 1 12rem;min-width:0" });
    var versionClear = h("button", { type: "button", class: "dw-btn", text: "Clear" });
    var versionCount = h("p", { class: "dw-help", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    var versionTable = h("div", { class: "dw-scroll" }, h("table", { class: "dw-table" }, h("thead", {}, h("tr", {}, h("th", { text: "Version" }), h("th", { text: "Message" }), h("th", { class: "num", text: "Files" }), h("th", { class: "num dw-hide-sm", text: "Published" }), h("th", {}))), vBody));
    var noVersionMatches = h("div", { class: "dw-empty", hidden: true }, h("h3", { text: "No matching versions" }), h("p", { text: "Try another filter or Clear to show the loaded versions." }));
    function filterVersions() {
      var q = versionFilter.value.trim().toLowerCase();
      var matching = 0;
      // Only hide existing rows: their immutable-id action closures and the
      // separately selected file manifest stay untouched, in server order.
      $$("tr[data-search]", vBody).forEach(function (tr) {
        tr.hidden = !!(q && tr.getAttribute("data-search").indexOf(q) < 0);
        if (!tr.hidden) matching++;
      });
      versionCount.textContent = plural(matching, "match", "matches") + " of " + plural(versions.length, "loaded version") + ".";
      versionTable.hidden = !matching;
      noVersionMatches.hidden = !versions.length || !!matching;
    }
    versionFilter.addEventListener("input", filterVersions);
    versionClear.addEventListener("click", function () {
      versionFilter.value = "";
      filterVersions();
      versionFilter.focus();
    });
    // Explicit version jump: open any version by reference (live, v3, 3 or an
    // immutable id), including versions older than the newest-100 rows.
    // Typing never fetches; each submit makes one bounded get_version lookup,
    // then loads the manifest pinned to the returned immutable id.
    var jumpInput = h("input", { class: "dw-input", id: "dw-version-ref", name: "version", type: "text", style: "max-width:14rem", placeholder: "live, v3, 3, or id", autocomplete: "off", spellcheck: "false", "aria-describedby": "dw-version-jump-help" });
    var jumpStatus = h("p", { class: "dw-small dw-muted", style: "margin:.4rem 0 0", role: "status", text: "" });
    var jumpErrorBox = h("div", { role: "alert", text: "" });
    var jumpForm = h(
      "form",
      { class: "dw-pad", id: "dw-version-jump", style: "padding-top:.75rem;padding-bottom:.75rem" },
      h("div", { class: "dw-row" }, h("label", { class: "dw-label", style: "margin:0", for: "dw-version-ref", text: "Version" }), jumpInput, h("button", { type: "submit", class: "dw-btn", text: "Open" })),
      h("p", { class: "dw-help", id: "dw-version-jump-help", text: "Open any version by reference. Nothing is fetched until you submit." }),
      jumpStatus,
      jumpErrorBox,
    );
    jumpForm.addEventListener("submit", function (e) {
      e.preventDefault();
      openVersionRef(jumpInput.value, { history: "push" });
    });
    var versionsSection = h(
      "section",
      { class: "dw-section" },
      h("header", {}, h("h2", { text: "Versions" }), h("span", { class: "dw-small dw-muted", text: plural(versions.length, "version") + (versions.length >= 100 ? " (newest 100)" : "") + ". Restoring is instant: it only moves the live pointer." })),
      jumpForm,
      h("div", { class: "dw-pad" },
        h("label", { class: "dw-label", for: "dw-version-filter", text: "Filter loaded versions" }),
        h("div", { class: "dw-row" }, versionFilter, versionClear),
        h("p", { id: "dw-version-scope", class: "dw-help", text: "Only the newest 100 versions are loaded. This filters loaded versions, not all history." }),
        versionCount,
      ),
      versions.length
        ? versionTable
        : h("div", { class: "dw-empty" }, h("h3", { text: "Nothing published yet" }), h("a", { class: "dw-btn primary", href: "/dashboard/publish?site=" + encodeURIComponent(slug), text: "Publish files" })),
      noVersionMatches,
    );
    filterVersions();

    // One token per selection attempt, whatever its source (history row,
    // version jump, traversal): a completion holding a stale token must not
    // touch the view, the URL, or the announced state. The token is per
    // page run, so completions also check mySiteRun: a selection still in
    // flight when this page re-runs belongs to a replaced closure.
    var selectionReq = 0;
    var displayedReq = 0;
    var currentSelection = null;
    function setJumpError(message, hint, opts) {
      clear(jumpErrorBox);
      add(jumpErrorBox, errorBox({ message: message, hint: hint }, null));
      // A refused traversal retains the manifest: reconcile this entry's URL
      // with that view, without pushing another history entry.
      if (opts && opts.history === "replace" && currentSelection && mySiteRun === siteRun) recordSelection(currentSelection.id, "replace");
    }
    function clearJumpError() {
      clear(jumpErrorBox);
    }
    function setJumpLoading(on) {
      jumpStatus.textContent = on ? "Opening version…" : "";
    }
    // The management URL always names the displayed manifest by immutable
    // id: explicit selections (history row, version jump) push an entry so
    // Back returns to the previous version; traversal and the initial load
    // replace the current entry instead of manufacturing new ones.
    function selectionUrl(id) {
      try {
        var u = new URL(location.href);
        u.searchParams.set("version", id);
        return u.pathname + u.search + u.hash;
      } catch (e) {
        return null;
      }
    }
    function recordSelection(id, mode) {
      var url = selectionUrl(id);
      if (!url || typeof history === "undefined") return;
      try {
        if (mode === "push" && typeof history.pushState === "function") history.pushState({ v: id }, "", url);
        else if (typeof history.replaceState === "function") history.replaceState({ v: id }, "", url);
        else if (typeof history.pushState === "function") history.pushState({ v: id }, "", url);
      } catch (e) {}
    }
    function commitSelection(mv, opts, my) {
      if (mySiteRun !== siteRun) return;
      displayedReq = my;
      currentSelection = { id: mv.id, number: mv.number };
      setJumpLoading(false);
      clearJumpError();
      if (opts.history) recordSelection(mv.id, opts.history);
    }
    // One path segment, never decoded: empty, dot-only and separator-like
    // references fail before any request; anything else goes out literally
    // encoded so "%2F" cannot become a second segment.
    function validVersionRef(ref) {
      if (!ref) return false;
      var t = ref.trim();
      if (!t || /^\.+$/.test(t)) return false;
      return !/[\/?#\\\x00-\x1f\x7f]/.test(t);
    }
    async function openVersionRef(raw, opts) {
      opts = opts || {};
      var my = ++selectionReq;
      var ref = (raw || "").trim();
      if (!validVersionRef(ref)) {
        setJumpLoading(false);
        setJumpError("Enter a version reference: live, v3, 3, or a version id.", "Check the reference and try again.", opts);
        // Explicit submits return focus for correction; traversal must not
        // steal it while the person is moving through history.
        if (opts.focus !== false) jumpInput.focus();
        return;
      }
      clearJumpError();
      setJumpLoading(true);
      var found;
      try {
        found = await api("/sites/" + encodeURIComponent(slug) + "/versions/" + encodeURIComponent(ref));
      } catch (e) {
        if (my !== selectionReq || mySiteRun !== siteRun) return;
        setJumpLoading(false);
        setJumpError(e.message || "Could not open that version.", "Check the reference and try again." + (e.hint ? " " + e.hint : ""), opts);
        return;
      }
      if (my !== selectionReq || mySiteRun !== siteRun) return;
      var v = found && found.version;
      if (!v || v.status === "pending") {
        setJumpLoading(false);
        if (!v) setJumpError("That version reference did not resolve.", "Check the reference and try again.", opts);
        else setJumpError("Version v" + v.number + " is not ready yet.", "Choose a ready version from the history, or retry once its upload finishes.", opts);
        return;
      }
      // showFiles takes the next token and loads the manifest pinned to the
      // returned immutable id, even when the version is not among the rows.
      showFiles(v, { history: opts.history || "push" });
    }
    async function showFiles(v, opts) {
      opts = opts || {};
      var my = ++selectionReq;
      var hadSelection = !!currentSelection;
      // History rows swap panels at once; jumps and traversal keep the valid
      // view until the replacement (or its failure) is known.
      if (!hadSelection || opts.clearFirst) {
        clear(filesSection);
        add(filesSection, h("header", {}, h("h2", { text: "Files in v" + v.number + (v.live ? " (live)" : "") })), skeleton(3));
      }
      setJumpLoading(true);
      var data;
      try {
        // Always pin the selected version by immutable ID: a live-row snapshot
        // may already be stale by the time this request lands.
        data = await api("/sites/" + encodeURIComponent(slug) + "/files?version=" + encodeURIComponent(v.id));
      } catch (e) {
        if (my !== selectionReq || mySiteRun !== siteRun) return;
        setJumpLoading(false);
        if (!hadSelection || opts.clearFirst) {
          clear(filesSection);
          add(filesSection, h("div", { class: "dw-pad" }, errorBox(e, "Could not load files")));
        } else {
          setJumpError(e.message || "Could not load files.", e.hint, opts);
        }
        return;
      }
      if (my !== selectionReq || mySiteRun !== siteRun) return;
      // Identity comes from the response, never the clicked row: the live
      // pointer may have moved between selection and retrieval.
      var mv = (data && data.version) || { id: v.id, number: v.number, live: v.live };
      if (mv.status === "pending") {
        setJumpLoading(false);
        var notReady = { message: "Version v" + mv.number + " is not ready yet.", hint: "Choose a ready version from the history, or retry once its upload finishes." };
        if (!hadSelection || opts.clearFirst) {
          clear(filesSection);
          add(filesSection, h("div", { class: "dw-pad" }, errorBox(notReady, "Version not ready")));
        } else {
          setJumpError(notReady.message, notReady.hint, opts);
        }
        return;
      }
      var rows = (data && data.files) || [];
      var filter = h("input", { class: "dw-input", type: "search", placeholder: "Filter files", "aria-label": "Filter files" });
      if (!rows.length) {
        clear(filesSection);
        add(
          filesSection,
          h("header", {}, h("h2", { text: "Files in v" + mv.number + (mv.live ? " (live)" : "") }), h("div", { class: "dw-row" }, h("span", { class: "dw-small dw-muted", "aria-live": "polite", "aria-atomic": "true", text: plural(rows.length, "loaded file") + " in this selected version · " + exactBytes(0) }), filter)),
          h("div", { class: "dw-empty" }, h("h3", { text: "No files in this version" }), h("p", { class: "dw-small", text: "This version has an empty manifest." })),
        );
        commitSelection(mv, opts, my);
        return;
      }
      var copyStatus = h("p", { class: "dw-pad dw-small", style: "margin:0", role: "status", text: "" });
      var copyReq = 0;
      var copyTimer = null;
      var tb = h("tbody");
      // Rows keep their own closures (checksum and download targets, links);
      // sorting only reorders these nodes and never mutates the manifest rows.
      var items = rows.map(function (f) {
        var tr = h(
          "tr",
          { "data-search": f.path.toLowerCase() },
          h("td", { class: "dw-mono" }, mv.live ? h("a", { href: "/v/" + encodeURIComponent(slug) + "/" + encodePath(f.path), text: f.path }) : h("span", { text: f.path })),
          h("td", { class: "dw-hide-sm" }, h("span", { class: "dw-badge", text: f.kind })),
          h("td", { class: "num dw-small" }, h("span", { text: exactBytes(f.size) }), f.size >= 1024 ? h("span", { class: "dw-sub", text: bytes(f.size) }) : null),
          h("td", {}, h("code", { class: "dw-mono dw-digest", text: f.sha256 })),
          h(
            "td",
            { class: "act" },
            mv.live ? h("a", { class: "dw-btn small", href: f.url, target: "_blank", rel: "noopener", text: "Open" }) : null,
            " ",
            h("button", {
              type: "button",
              class: "dw-btn small",
              text: "Copy SHA-256",
              "aria-label": "Copy SHA-256 for " + f.path,
              onclick: function (ev) {
                var btn = ev.currentTarget;
                var attempt = ++copyReq;
                clearTimeout(copyTimer);
                copyStatus.textContent = "";
                copyText(f.sha256, btn).then(function (ok) {
                  if (attempt !== copyReq || my !== displayedReq) return;
                  // A separate task makes identical results observable again.
                  copyTimer = setTimeout(function () {
                    if (attempt !== copyReq || my !== displayedReq) return;
                    copyStatus.textContent = ok
                      ? "Copied SHA-256 for " + f.path + "."
                      : "Copy failed for " + f.path + ". Select the checksum and copy it yourself.";
                  }, 0);
                });
              },
            }),
            " ",
            // Pin every download to the inspected manifest: even a live-marked
            // row describes immutable bytes, and the live pointer may move on.
            h("button", { type: "button", class: "dw-btn small", text: "Download", onclick: function (ev) { downloadFile(slug, f.path, mv.id, ev.currentTarget); } }),
          ),
        );
        tb.appendChild(tr);
        return { file: f, row: tr };
      });
      // Client-side ordering of the already-loaded manifest: no requests, no
      // storage, no endpoint. Default is deterministic Path ascending.
      var sortField = "path";
      var sortDir = "ascending";
      var headCells = {};
      var fieldSelect = null;
      var dirSelect = null;
      function cmpText(a, b) {
        return a < b ? -1 : a > b ? 1 : 0;
      }
      function compareFiles(a, b) {
        var primary = sortField === "size" ? a.size - b.size : cmpText(sortField === "kind" ? a.kind : a.path, sortField === "kind" ? b.kind : b.path);
        if (primary !== 0) return sortDir === "ascending" ? primary : -primary;
        if (sortField === "path") return 0;
        return cmpText(a.path, b.path);
      }
      // Filter feedback is derived only from the already-loaded rows for this
      // selected version: updating it never fetches, writes storage or moves
      // focus (the filter keeps focus while typing). One persistent status
      // element is updated in place so live announcements are not lost.
      // aria-live (not role="status") so the checksum copy announcements keep
      // the section's single status region and existing contracts hold.
      var filterStatus = h("span", { class: "dw-small dw-muted", "aria-live": "polite", "aria-atomic": "true", text: "" });
      var noMatch = h("div", { class: "dw-empty", hidden: true, text: "" });
      var clearFilter = h("button", {
        type: "button",
        class: "dw-btn small",
        text: "Clear filter",
        hidden: true,
        onclick: function () {
          // Reset only the query: sort, checksums, downloads and the
          // selected immutable version are untouched. Focus returns to the
          // filter so keyboard users land where they were.
          filter.value = "";
          applyFilter();
          filter.focus();
        },
      });
      function applyFilter() {
        var raw = filter.value;
        var q = raw.trim().toLowerCase();
        var matching = 0;
        var matchingBytes = 0;
        items.forEach(function (it) {
          var show = !q || it.row.getAttribute("data-search").indexOf(q) >= 0;
          it.row.hidden = !show;
          if (show) {
            matching++;
            matchingBytes += it.file.size || 0;
          }
        });
        filterStatus.textContent = q
          ? matching + " of " + plural(items.length, "loaded file") + " in this selected version match · " + exactBytes(matchingBytes) + " matching"
          : plural(items.length, "loaded file") + " in this selected version · " + exactBytes(matchingBytes);
        clearFilter.hidden = !raw;
        // The query is quoted back as inert text (textContent), never markup;
        // a nonempty manifest with zero matches is not an empty version.
        var noMatches = !!q && matching === 0;
        noMatch.hidden = !noMatches;
        noMatch.textContent = noMatches ? 'No matching files for "' + raw + '" in the loaded files for this selected version. Clear the filter to show every loaded file.' : "";
      }
      function applySort() {
        items
          .slice()
          .sort(function (x, y) {
            return compareFiles(x.file, y.file);
          })
          .forEach(function (it) {
            tb.appendChild(it.row);
          });
        ["path", "kind", "size"].forEach(function (field) {
          var hc = headCells[field];
          if (!hc) return;
          if (field === sortField) {
            hc.th.setAttribute("aria-sort", sortDir);
            hc.arrow.textContent = sortDir === "ascending" ? " ▲" : " ▼";
            hc.btn.setAttribute("aria-label", "Sort by " + field + ", " + sortDir + " (activate to sort " + (sortDir === "ascending" ? "descending" : "ascending") + ")");
          } else {
            hc.th.removeAttribute("aria-sort");
            hc.arrow.textContent = "";
            hc.btn.setAttribute("aria-label", "Sort by " + field);
          }
        });
        if (fieldSelect) fieldSelect.value = sortField;
        if (dirSelect) dirSelect.value = sortDir;
        applyFilter();
      }
      function sortTh(field, label, cls) {
        var arrow = h("span", { "aria-hidden": "true" });
        var btn = h(
          "button",
          {
            type: "button",
            class: "dw-th-sort",
            "aria-label": "Sort by " + field,
            onclick: function () {
              if (sortField === field) sortDir = sortDir === "ascending" ? "descending" : "ascending";
              else {
                sortField = field;
                sortDir = "ascending";
              }
              applySort();
            },
          },
          h("span", { text: label }),
          arrow,
        );
        var th = h("th", { scope: "col", class: cls || null, "data-sort-field": field }, btn);
        headCells[field] = { th: th, btn: btn, arrow: arrow };
        return th;
      }
      function sortOption(value, label) {
        var o = h("option", { text: label });
        o.value = value;
        o.setAttribute("value", value);
        return o;
      }
      // Toolbar mirror of the header sorts: every field stays sortable on narrow
      // screens, where the Kind column (and its header control) is hidden.
      fieldSelect = h("select", { class: "dw-select", "aria-label": "Sort files by" }, sortOption("path", "Path"), sortOption("kind", "Kind"), sortOption("size", "Size"));
      fieldSelect.value = sortField;
      fieldSelect.addEventListener("change", function () {
        sortField = fieldSelect.value;
        sortDir = "ascending";
        applySort();
      });
      dirSelect = h("select", { class: "dw-select", "aria-label": "Sort direction" }, sortOption("ascending", "Ascending"), sortOption("descending", "Descending"));
      dirSelect.value = sortDir;
      dirSelect.addEventListener("change", function () {
        sortDir = dirSelect.value;
        applySort();
      });
      var sortBar = h("label", { class: "dw-sort" }, h("span", { class: "dw-small dw-muted", text: "Sort" }), fieldSelect, dirSelect);
      filter.addEventListener("input", applyFilter);
      clear(filesSection);
      add(
        filesSection,
        h("header", {}, h("h2", { text: "Files in v" + mv.number + (mv.live ? " (live)" : "") }), h("div", { class: "dw-row" }, filterStatus, sortBar, filter, clearFilter)),
        h("p", { class: "dw-pad dw-small dw-muted", style: "margin:0", text: "SHA-256 manifest checksums for the selected version (v" + mv.number + ", " + mv.id + "). A checksum is not proof of authenticity, provenance, safe content, or independent verification, and does not show the current live download matches — compare it against a trusted source you already have." }),
        h("div", { class: "dw-scroll" }, h("table", { class: "dw-table" }, h("thead", {}, h("tr", {}, sortTh("path", "Path"), sortTh("kind", "Kind", "dw-hide-sm"), sortTh("size", "Size", "num"), h("th", { scope: "col", text: "SHA-256" }), h("th", { scope: "col" }))), tb)),
        noMatch,
        copyStatus,
        mv.live ? null : h("p", { class: "dw-pad dw-small dw-muted", style: "margin:0", text: "Older versions are not served publicly. Restore this version to view it on the site, or download single files." }),
      );
      applySort();
      commitSelection(mv, opts, my);
    }

    var s = site.settings;
    var form = h(
      "form",
      { class: "dw-pad" },
      h("div", { class: "dw-grid2" },
        h("div", { class: "dw-field" }, h("label", { class: "dw-label", for: "dw-s-title", text: "Title" }), h("input", { class: "dw-input", id: "dw-s-title", name: "title", maxlength: "200", value: site.title || "" })),
        h("div", { class: "dw-field" }, h("label", { class: "dw-label", for: "dw-s-desc", text: "Description" }), h("input", { class: "dw-input", id: "dw-s-desc", name: "description", maxlength: "2000", value: site.description || "" })),
      ),
      h("label", { class: "dw-check" }, h("input", { type: "checkbox", name: "spa", checked: s.spa }), h("span", {}, "Single-page app", h("span", { class: "dw-sub", text: "Unknown paths serve index.html (client-side routing)." }))),
      h("label", { class: "dw-check" }, h("input", { type: "checkbox", name: "renderMarkdown", checked: s.renderMarkdown }), h("span", {}, "Render Markdown", h("span", { class: "dw-sub", text: "Browsers see .md files as pages; off serves the raw text." }))),
      h("label", { class: "dw-check" }, h("input", { type: "checkbox", name: "crossOriginIsolation", checked: s.crossOriginIsolation }), h("span", {}, "Cross-origin isolation", h("span", { class: "dw-sub", text: "Sends COOP/COEP so threaded WebAssembly (SharedArrayBuffer) works. Cross-origin embeds then need CORP." }))),
      h("div", { class: "dw-field", style: "margin-top:.9rem" },
        h("label", { class: "dw-label", for: "dw-s-pw", text: s.passwordProtected ? "Password (set; type a new one to change it)" : "Password (optional)" }),
        h("div", { class: "dw-row" }, h("input", { class: "dw-input", id: "dw-s-pw", name: "password", type: "password", autocomplete: "new-password", minlength: "4", maxlength: "200", style: "max-width:18rem" }),
          s.passwordProtected ? h("button", { type: "button", class: "dw-btn", "data-site-mutation": "", text: "Remove password", onclick: async function () { await saveSettings({ password: null }, "Password removed."); } }) : null),
        h("p", { class: "dw-help", text: "Visitors must enter it. Changing it signs everyone out." }),
      ),
      h("div", { class: "dw-row" }, h("button", { type: "submit", class: "dw-btn primary", "data-site-mutation": "", text: "Save settings" })),
    );
    async function saveSettings(body, msg) {
      if (siteMutationPending) return;
      setSiteMutationPending(true);
      try {
        await api("/sites/" + encodeURIComponent(slug), { method: "PATCH", body: body });
        toast(msg || "Saved.");
        pages.site();
      } catch (e) {
        toast(e.message + (e.hint ? " " + e.hint : ""), true);
      } finally {
        setSiteMutationPending(false);
      }
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var f = form.elements;
      var body = { title: f.title.value.trim() || null, description: f.description.value.trim() || null, spa: f.spa.checked, renderMarkdown: f.renderMarkdown.checked, crossOriginIsolation: f.crossOriginIsolation.checked };
      if (f.password.value) body.password = f.password.value;
      saveSettings(body);
    });
    var renamePending = false;
    var renameInput = h("input", { class: "dw-input", id: "dw-s-new-slug", name: "newSlug", type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-describedby": "dw-s-rename-help dw-s-rename-feedback" });
    var renameFeedback = h("div", { id: "dw-s-rename-feedback", role: "status", "aria-live": "polite" });
    var renameSubmit = h("button", { type: "submit", class: "dw-btn primary", "data-site-mutation": "", text: "Rename site" });
    var renameCancel = h("button", {
      type: "button", class: "dw-btn", text: "Cancel",
      onclick: function () {
        if (renamePending) return;
        renameInput.value = "";
        renameInput.removeAttribute("aria-invalid");
        clear(renameFeedback);
        renameInput.focus();
      },
    });
    var renameForm = h(
      "form", { class: "dw-pad", "aria-label": "Rename site" },
      h("p", { class: "dw-small" }, "Current slug: ", h("strong", { class: "dw-mono", text: site.slug })),
      h("div", { class: "dw-field" },
        h("label", { class: "dw-label", for: "dw-s-new-slug", text: "Proposed slug" }), renameInput,
        h("p", { class: "dw-help", id: "dw-s-rename-help", text: "Use 3–56 characters: letters, digits and single hyphens. Renaming changes the site URL. The server decides whether the name is available and how long the old name stays bound." })),
      h("div", { class: "dw-row" }, renameSubmit, renameCancel), renameFeedback,
    );
    renameForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (siteMutationPending) return;
      clear(renameFeedback);
      renameInput.removeAttribute("aria-invalid");
      if (renameInput.value.trim().toLowerCase() === site.slug) {
        renameFeedback.textContent = "This site already has that name. Nothing changed.";
        renameInput.focus();
        return;
      }
      renamePending = true;
      setSiteMutationPending(true);
      renameForm.setAttribute("aria-busy", "true");
      renameInput.disabled = renameSubmit.disabled = renameCancel.disabled = true;
      renameSubmit.textContent = "Rename site…";
      try {
        var renamed = await api("/sites/" + encodeURIComponent(slug) + "/rename", { method: "POST", body: { newSlug: renameInput.value } });
        var invalidReceipt = "Could not confirm the rename response. Reload this site before trying again.";
        if (!renamed || typeof renamed.renamed !== "boolean" || typeof renamed.slug !== "string" || !renamed.slug || typeof renamed.url !== "string") throw new Error(invalidReceipt);
        var returnedUrl;
        try { returnedUrl = new URL(renamed.url); } catch (err) { throw new Error(invalidReceipt); }
        if (["https:", "http:"].indexOf(returnedUrl.protocol) < 0 || returnedUrl.username || returnedUrl.password) throw new Error(invalidReceipt);
        if (!renamed.renamed) {
          renameFeedback.textContent = "This site already has that name. Nothing changed.";
          renameInput.focus();
          return;
        }
        var receipt = h("section", { class: "dw-section", tabindex: "-1", role: "status", "aria-live": "polite", "aria-labelledby": "dw-rename-result" },
          h("header", {}, h("h2", { id: "dw-rename-result", text: "Renamed to " + renamed.slug })),
        );
        var details = h("div", { class: "dw-pad", style: "overflow-wrap:anywhere" },
          h("p", {}, "Previous slug: ", h("strong", { class: "dw-mono", text: renamed.oldSlug || site.slug })),
          h("p", {}, "Old URL: ", h("span", { text: site.url })),
          h("p", {}, "New URL: ", h("a", { href: renamed.url, target: "_blank", rel: "noopener", text: renamed.url })),
        );
        var deadline = renamed.redirectUntil && new Date(renamed.redirectUntil);
        if (deadline && Number.isFinite(deadline.getTime())) {
          add(details, h("p", {}, "Returned redirect deadline: ", h("time", { datetime: renamed.redirectUntil, text: deadline.toLocaleString() }), "."),
            h("p", { class: "dw-small dw-muted", text: deadline.getTime() > Date.now()
              ? "The old URL redirects (308) to the new URL until this deadline. The old name remains bound to this site during that configured lifetime. Redirects are not promised after the deadline."
              : "This redirect deadline has expired. No active 308 redirect is guaranteed. Name retention follows the configured policy." }));
        } else {
          add(details, h("p", { class: "dw-small dw-muted", text: "No redirect deadline was provided. An active 308 redirect from the old URL is not guaranteed. The old name remains subject to the configured retention policy." }));
        }
        add(details, h("a", { class: "dw-btn primary", href: "/dashboard/sites/" + encodeURIComponent(renamed.slug), text: "Manage " + renamed.slug }));
        add(receipt, details);
        // Retire old-slug controls; management resumes only with the confirmed identity.
        clear(root);
        add(root, receipt);
        d.title = renamed.slug + " · " + boot.instanceName;
        receipt.focus();
      } catch (err) {
        add(renameFeedback, errorBox(err, "Could not rename site"));
        renameInput.setAttribute("aria-invalid", "true");
      } finally {
        renamePending = false;
        setSiteMutationPending(false);
        renameForm.removeAttribute("aria-busy");
        renameInput.disabled = renameSubmit.disabled = renameCancel.disabled = false;
        renameSubmit.textContent = "Rename site";
        if ($$("form", root).indexOf(renameForm) >= 0) renameInput.focus();
      }
    });
    var renameSection = h("section", { class: "dw-section" }, h("header", {}, h("h2", { text: "Rename site" })), renameForm);
    var danger = h(
      "section",
      { class: "dw-section" },
      h("header", {}, h("h2", { text: "Delete site" })),
      h(
        "div",
        { class: "dw-pad dw-row", style: "justify-content:space-between" },
        h("span", { class: "dw-small dw-muted", text: "The URL stops serving this site at once. Its name and any retained old names are held according to the configured name-retention policy. Deletion does not make a name immediately available to another tenant. Files no other site uses are removed by the hourly cleanup." }),
        h("button", {
          type: "button",
          class: "dw-btn danger",
          text: "Delete site",
          "data-site-mutation": "",
          onclick: async function (ev) {
            if (siteMutationPending) return;
            var trigger = ev.currentTarget;
            setSiteMutationPending(true);
            try {
              var ok = await confirmBox({ title: "Delete " + slug + "?", message: "Every version goes with it. This cannot be undone from the dashboard.", confirmText: "Delete site", typeToConfirm: slug });
              if (!ok) return;
              await api("/sites/" + encodeURIComponent(slug), { method: "DELETE", body: { confirm: slug } });
              location.href = "/dashboard?deleted=" + encodeURIComponent(slug);
            } catch (e) {
              toast(e.message, true);
            } finally {
              setSiteMutationPending(false);
              if ($$("button", root).indexOf(trigger) >= 0) trigger.focus();
            }
          },
        }),
      ),
    );
    var qrSection = siteQrSection(site.url, !!(site.settings && site.settings.passwordProtected));
    add(root, head, qrSection, versionsSection, filesSection, h("section", { class: "dw-section" }, h("header", {}, h("h2", { text: "Settings" })), form), renameSection, danger);
    var live = versions.filter(function (v) {
      return v.live;
    })[0];
    if (typeof window !== "undefined" && window.addEventListener) {
      if (sitePopstate && typeof window.removeEventListener === "function") {
        try {
          window.removeEventListener("popstate", sitePopstate);
        } catch (e) {}
      }
      sitePopstate = function () {
        var ref = null;
        try {
          ref = new URL(location.href).searchParams.get("version");
        } catch (e) {}
        if (ref && currentSelection && ref === currentSelection.id) {
          // Forward can return to the displayed view while Back's request is
          // still pending. Even this no-op navigation supersedes that request.
          ++selectionReq;
          setJumpLoading(false);
          clearJumpError();
          return;
        }
        if (ref) openVersionRef(ref, { history: "replace", focus: false });
        else if (live) showFiles(live, { history: "replace" });
      };
      window.addEventListener("popstate", sitePopstate);
    }
    if (requestedVersion && linkedVersion && linkedVersion.status === "pending") {
      // A pending link names unfinished bytes: report it, never render it as
      // an inspected version, and never fall back to live.
      add(filesSection, h("div", { class: "dw-pad" }, errorBox({ message: "Version v" + linkedVersion.number + " is not ready yet — its upload has not finished.", hint: "Choose a ready version from the history, or retry once the upload finishes." }, "Version not ready")));
    } else {
      var selected = requestedVersion ? linkedVersion : live;
      if (selected) showFiles(selected, { history: requestedVersion ? "replace" : null });
      else if (requestedVersion) add(filesSection, h("div", { class: "dw-pad" }, errorBox(linkedVersionError || { message: "This version is unavailable." }, "Version unavailable")));
      else filesSection.hidden = true;
    }
  };

  async function downloadFile(slug, path, versionId, btn) {
    if (btn) btn.disabled = true;
    try {
      var res = await api("/sites/" + encodeURIComponent(slug) + "/files/" + encodePath(path) + (versionId ? "?version=" + encodeURIComponent(versionId) : ""), { raw: true });
      var blob = await res.blob();
      // Force a download: never open user bytes as a page on the app origin.
      var a = h("a", { href: URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" })), download: path.split("/").pop() });
      d.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  pages.publish = function () {
    if (!requireAuth()) return;
    renderAccount();
    var root = d.getElementById("dw-publish");
    if (root) mountPublisher(root, { site: new URLSearchParams(location.search).get("site") });
  };

  pages.keys = async function () {
    if (!requireAuth()) return;
    var m = await renderAccount();
    var root = d.getElementById("dw-keys");
    clear(root);
    if (!m) m = await me().catch(function () {
      return null;
    });
    if (!can(m, "keys:write")) {
      add(root, errorBox({ message: "This key cannot manage API keys.", hint: "Sign in with a key that has the keys:write scope." }));
      return;
    }
    var created = h("div");
    var listBody = h("div", {}, skeleton(3));
    var showAll = can(m, "members:write") ? h("input", { type: "checkbox" }) : null;
    var scopeBoxes = m.scopes.map(function (sc) {
      return h("label", { class: "dw-check" }, h("input", { type: "checkbox", name: "scope", value: sc, checked: true }), h("span", { class: "dw-mono", text: sc }));
    });
    var siteSel = h("select", { class: "dw-select", name: "site", id: "dw-k-site" }, h("option", { value: "", text: m.siteRestriction ? "Same site as this key" : "All sites" }));
    var form = h(
      "form",
      { class: "dw-pad" },
      h("div", { class: "dw-grid2" },
        h("div", { class: "dw-field" }, h("label", { class: "dw-label", for: "dw-k-name", text: "Name" }), h("input", { class: "dw-input", id: "dw-k-name", name: "name", maxlength: "120", placeholder: "e.g. claude-code on laptop", required: true })),
        h("div", { class: "dw-field" }, h("label", { class: "dw-label", for: "dw-k-site", text: "Limit to one site" }), siteSel),
        h("div", { class: "dw-field" }, h("label", { class: "dw-label", for: "dw-k-exp", text: "Expires after (days)" }), h("input", { class: "dw-input", id: "dw-k-exp", name: "expires", type: "number", min: "1", max: "3650", placeholder: "never" })),
      ),
      h("fieldset", { style: "border:0;padding:0;margin:0 0 .75rem" }, h("legend", { class: "dw-label", text: "Scopes" }), h("div", { class: "dw-row", style: "gap:.25rem 1.25rem" }, scopeBoxes), h("p", { class: "dw-help", text: "A key can never hold more than the key you are signed in with." })),
      h("button", { type: "submit", class: "dw-btn primary", text: "Create key" }),
    );
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clear(created);
      var scopes = $$("input[name=scope]:checked", form).map(function (x) {
        return x.value;
      });
      var body = { name: form.elements.name.value.trim(), scopes: scopes };
      if (form.elements.site.value) body.site = form.elements.site.value;
      if (form.elements.expires.value) body.expiresInDays = Number(form.elements.expires.value);
      try {
        var k = await api("/keys", { method: "POST", body: body });
        add(
          created,
          secretBlock("Key “" + (k.name || k.prefix) + "” created", k.key, "Shown once. Give it to the agent or person as KOFRA_API_KEY."),
          h("pre", { class: "dw-snippet", text: "export KOFRA_URL=" + boot.origin + "\nexport KOFRA_API_KEY=" + k.key }),
        );
        form.reset();
        loadKeys();
      } catch (err) {
        add(created, errorBox(err, "Could not create the key"));
      }
    });
    add(
      root,
      h("section", { class: "dw-section" }, h("header", {}, h("h2", { text: "Create a key" }), h("span", { class: "dw-small dw-muted", text: "One key per agent or person makes revoking easy." })), form, h("div", { class: "dw-pad", style: "padding-top:0" }, created)),
      h(
        "section",
        { class: "dw-section" },
        h("header", {}, h("h2", { text: "Active keys" }), showAll ? h("label", { class: "dw-check", style: "margin:0" }, showAll, h("span", { class: "dw-small", text: "Every member's keys" })) : null),
        listBody,
      ),
    );
    if (showAll) showAll.addEventListener("change", loadKeys);
    api("/sites?limit=200")
      .then(function (r) {
        r.sites.forEach(function (s) {
          siteSel.appendChild(h("option", { value: s.slug, text: s.slug }));
        });
      })
      .catch(function () {});
    async function loadKeys() {
      try {
        var res = await api("/keys" + (showAll && showAll.checked ? "?all=1" : ""));
        clear(listBody);
        if (!res.keys.length) {
          add(listBody, h("div", { class: "dw-empty", text: "No active keys." }));
          return;
        }
        var tb = h("tbody");
        res.keys.forEach(function (k) {
          tb.appendChild(
            h(
              "tr",
              {},
              h("td", {}, h("strong", { text: k.name || "Unnamed" }), " ", k.current ? h("span", { class: "dw-badge accent", text: "This browser" }) : null, h("span", { class: "dw-sub dw-mono", text: k.prefix + "…" })),
              h("td", { class: "dw-small" }, k.scopes.map(function (sc) {
                return h("span", { class: "dw-badge", style: "margin:0 .2rem .2rem 0", text: sc });
              }), k.siteId ? h("span", { class: "dw-sub", text: "One site only" }) : null),
              h("td", { class: "num dw-small dw-muted dw-hide-sm" }, h("span", { title: k.createdAt, text: "Created " + ago(k.createdAt) }), h("span", { class: "dw-sub", text: k.lastUsedAt ? "Used " + ago(k.lastUsedAt) : "Never used" })),
              h("td", { class: "num dw-small dw-hide-sm", text: k.expiresAt ? "Expires " + new Date(k.expiresAt).toLocaleDateString() : "No expiry" }),
              h(
                "td",
                { class: "act" },
                h("button", {
                  type: "button",
                  class: "dw-btn small danger",
                  text: "Revoke",
                  "aria-label": "Revoke key " + (k.name || k.prefix),
                  onclick: async function () {
                    var ok = await confirmBox({
                      title: "Revoke “" + (k.name || k.prefix) + "”?",
                      message: k.current ? "This is the key this browser is signed in with: you will be signed out." : "Anything using this key stops working at once.",
                      confirmText: "Revoke",
                    });
                    if (!ok) return;
                    try {
                      await api("/keys/" + encodeURIComponent(k.id), { method: "DELETE" });
                      if (k.current) {
                        clearKey();
                        location.href = "/login?signedout=1";
                        return;
                      }
                      toast("Key revoked.");
                      loadKeys();
                    } catch (e) {
                      toast(e.message, true);
                    }
                  },
                }),
              ),
            ),
          );
        });
        add(listBody, h("div", { class: "dw-scroll" }, h("table", { class: "dw-table" }, h("thead", {}, h("tr", {}, h("th", { text: "Key" }), h("th", { text: "Scopes" }), h("th", { class: "num dw-hide-sm", text: "Activity" }), h("th", { class: "num dw-hide-sm", text: "Expiry" }), h("th", {}))), tb)));
      } catch (e) {
        clear(listBody);
        add(listBody, h("div", { class: "dw-pad" }, errorBox(e, "Could not load keys")));
      }
    }
    loadKeys();
  };

  /**
   * Read-only effective-policy section for /dashboard/settings, rendered from the
   * already-fetched /me response (no extra request, no polling). Shows the four
   * caller-effective limits, site/storage usage against their configured limits,
   * and every returned capability by its stable id. Refusal codes, messages and
   * hints render as plain text. Null when /me carries no policy fields (older
   * responses), so legacy output renders exactly as before.
   */
  function effectivePolicySection(m) {
    var limits = m && m.limits && typeof m.limits === "object" ? m.limits : null;
    var usage = m && m.usage && typeof m.usage === "object" ? m.usage : null;
    var caps = m && m.capabilities && typeof m.capabilities === "object" ? m.capabilities : null;
    if (!limits && !usage && !caps) return null;
    limits = limits || {};
    usage = usage || {};
    caps = caps || {};

    function isCount(n) {
      return typeof n === "number" && isFinite(n) && n >= 0 && Math.floor(n) === n;
    }
    /** Exact bytes plus the shared short form, so a limit is never ambiguous. */
    function byteText(n) {
      return n + " bytes (" + bytes(n) + ")";
    }
    /** Only the sites/storage quotas use null-as-unlimited; other nulls stay ordinary. */
    function quotaText(limit) {
      if (limit === null) return "unlimited";
      return isCount(limit) ? String(limit) : "unavailable";
    }
    function usedOf(label, used, limit) {
      var l = quotaText(limit);
      if (!isCount(used) && l === "unavailable") return "usage and limit unavailable";
      if (!isCount(used)) return "usage unavailable of " + l + " " + label;
      if (l === "unavailable") return used + " " + label + " in use, limit unavailable";
      return used + " of " + l + " " + label;
    }
    function storageText(used, limit) {
      var l = limit === null ? "unlimited" : isCount(limit) ? byteText(limit) : "unavailable";
      if (!isCount(used) && l === "unavailable") return "usage and limit unavailable";
      if (!isCount(used)) return "usage unavailable of " + l + " retained";
      if (l === "unavailable") return byteText(used) + " retained, limit unavailable";
      return byteText(used) + " of " + l + " retained";
    }
    function capabilityItem(id, decision) {
      var li = h("li", {}, h("code", { text: id }), " — ");
      if (!decision || typeof decision !== "object" || (decision.allowed !== true && decision.allowed !== false)) {
        return add(li, "Unknown state.");
      }
      if (decision.allowed === true) return add(li, "Allowed.");
      var err = decision.error && typeof decision.error === "object" ? decision.error : {};
      add(li, "Unavailable. ");
      if (err.code !== undefined && err.code !== null && err.code !== "") add(li, h("span", { class: "dw-mono", text: String(err.code) }), ": ");
      if (err.message !== undefined && err.message !== null && err.message !== "") add(li, String(err.message), " ");
      if (err.hint !== undefined && err.hint !== null && err.hint !== "") add(li, String(err.hint), " ");
      var req = err.details && Array.isArray(err.details.requires) ? err.details.requires : null;
      if (req && req.length) add(li, "Requires: " + req.join(", ") + ".");
      return li;
    }

    var ids = Object.keys(caps);
    var capList = h("ul", { class: "dw-small", style: "margin:.75rem 0 0" });
    if (!ids.length) add(capList, h("li", { text: "Capability information unavailable." }));
    ids.forEach(function (id) {
      add(capList, capabilityItem(id, caps[id]));
    });
    return h(
      "section",
      { style: "margin-top:1rem", "aria-labelledby": "dw-effective-policy-h" },
      h("h3", { id: "dw-effective-policy-h", text: "Your effective limits and capabilities" }),
      h("p", { class: "dw-small dw-muted", text: "Effective values for the key you signed in with. They can be lower than the instance defaults under “This instance”." }),
      h("p", { class: "dw-small dw-muted", text: "Allowed means this instance supports the capability for your key; each call still checks its own scopes. Storage counts bytes retained for your account, including earlier versions and deliveries." }),
      h(
        "dl",
        { class: "dw-kv", style: "margin-top:.75rem" },
        h("dt", { text: "Largest file" }), h("dd", { text: isCount(limits.maxFileBytes) ? byteText(limits.maxFileBytes) : "unavailable" }),
        h("dt", { text: "Files per version" }), h("dd", { text: isCount(limits.maxFiles) ? plural(limits.maxFiles, "file") : "unavailable" }),
        h("dt", { text: "Largest version" }), h("dd", { text: isCount(limits.maxSiteBytes) ? byteText(limits.maxSiteBytes) : "unavailable" }),
        h("dt", { text: "One-call publish body" }), h("dd", { text: isCount(limits.oneShotMaxBytes) ? byteText(limits.oneShotMaxBytes) : "unavailable" }),
      ),
      h(
        "dl",
        { class: "dw-kv", style: "margin-top:.75rem" },
        h("dt", { text: "Sites" }), h("dd", { text: usedOf("sites", usage.sites, limits.sites) }),
        h("dt", { text: "Retained storage" }), h("dd", { text: storageText(usage.storage_bytes, limits.storage_bytes) }),
      ),
      capList,
    );
  }

  pages.settings = async function () {
    if (!requireAuth()) return;
    // Usage and capability decisions must be fresh on each Settings visit.
    var s = store("session");
    if (s) s.removeItem(ME);
    var m = await renderAccount();
    var acct = d.getElementById("dw-me");
    if (acct && m && m.member) {
      clear(acct);
      add(
        acct,
        h(
          "dl",
          { class: "dw-kv" },
          h("dt", { text: "Signed in as" }), h("dd", { text: m.member.email || m.member.name || m.member.id }),
          h("dt", { text: "Role" }), h("dd", { text: m.member.role }),
          h("dt", { text: "Key scopes" }), h("dd", { class: "dw-mono", text: m.scopes.join(" ") }),
          h("dt", { text: "Key limited to a site" }), h("dd", { text: m.siteRestriction ? "yes" : "no" }),
        ),
        effectivePolicySection(m),
      );
    }
    var mem = d.getElementById("dw-members");
    if (!mem) return;
    if (!can(m, "members:write")) {
      mem.closest("section").hidden = true;
      return;
    }
    var out = h("div");
    var list = h("div", {}, skeleton(2));
    var form = h(
      "form",
      { class: "dw-row", style: "align-items:flex-end" },
      h("div", { style: "flex:1 1 14rem" }, h("label", { class: "dw-label", for: "dw-m-email", text: "Email" }), h("input", { class: "dw-input", id: "dw-m-email", name: "email", type: "email", required: true })),
      h("div", { style: "flex:1 1 10rem" }, h("label", { class: "dw-label", for: "dw-m-name", text: "Name" }), h("input", { class: "dw-input", id: "dw-m-name", name: "name" })),
      h("div", {}, h("label", { class: "dw-label", for: "dw-m-role", text: "Role" }), h("select", { class: "dw-select", id: "dw-m-role", name: "role" }, h("option", { value: "member", text: "Member" }), h("option", { value: "admin", text: "Admin" }), m.member.role === "owner" ? h("option", { value: "owner", text: "Owner" }) : null)),
      h("button", { type: "submit", class: "dw-btn primary", text: "Add member" }),
    );
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clear(out);
      try {
        var r = await api("/members", { method: "POST", body: { email: form.elements.email.value.trim(), name: form.elements.name.value.trim() || undefined, role: form.elements.role.value } });
        add(out, secretBlock("API key for " + (r.member.email || r.member.name), r.apiKey.key, "Shown once. Send it to them over a private channel; they sign in with it."));
        form.reset();
        loadMembers();
      } catch (err) {
        add(out, errorBox(err, "Could not add the member"));
      }
    });
    clear(mem);
    add(mem, list, h("div", { class: "dw-pad" }, form, out));
    async function loadMembers() {
      try {
        var res = await api("/members");
        clear(list);
        var tb = h("tbody");
        res.members.forEach(function (x) {
          tb.appendChild(
            h(
              "tr",
              {},
              h("td", {}, h("strong", { text: x.email || x.name || x.id }), x.name && x.email ? h("span", { class: "dw-sub", text: x.name }) : null),
              h("td", {}, h("span", { class: "dw-badge" + (x.role === "owner" ? " accent" : ""), text: x.role })),
              h("td", { class: "num dw-small dw-muted dw-hide-sm", text: "Added " + ago(x.createdAt) }),
              h(
                "td",
                { class: "act" },
                x.id === m.member.id
                  ? h("span", { class: "dw-small dw-muted", text: "You" })
                  : h("button", {
                      type: "button",
                      class: "dw-btn small danger",
                      text: "Remove",
                      onclick: async function () {
                        var ok = await confirmBox({ title: "Remove " + (x.email || x.name || x.id) + "?", message: "Their API keys stop working at once. Sites they published stay.", confirmText: "Remove member" });
                        if (!ok) return;
                        try {
                          await api("/members/" + encodeURIComponent(x.id), { method: "DELETE" });
                          toast("Member removed.");
                          loadMembers();
                        } catch (e) {
                          toast(e.message, true);
                        }
                      },
                    }),
              ),
            ),
          );
        });
        add(list, h("div", { class: "dw-scroll" }, h("table", { class: "dw-table" }, h("thead", {}, h("tr", {}, h("th", { text: "Member" }), h("th", { text: "Role" }), h("th", { class: "num dw-hide-sm", text: "Added" }), h("th", {}))), tb)));
      } catch (e) {
        clear(list);
        add(list, h("div", { class: "dw-pad" }, errorBox(e, "Could not load members")));
      }
    }
    loadMembers();
  };

  // ------------------------------------------------------------------ file viewer (/v/:slug/*path)

  pages.viewer = async function () {
    renderAccount();
    var slug = P.slug;
    var frame = d.getElementById("dw-frame");
    var tree = d.getElementById("dw-tree");
    var tools = d.getElementById("dw-tools");
    var info = d.getElementById("dw-fileinfo");
    var current = P.path || "";
    var manifest = null;

    function fileByPath(p) {
      if (!manifest) return null;
      for (var i = 0; i < manifest.files.length; i++) if (manifest.files[i].path === p) return manifest.files[i];
      return null;
    }
    function siteUrlFor(p) {
      var f = fileByPath(p);
      if (f) return f.url;
      return P.siteUrl + encodePath(p);
    }
    function viewSrc(p, mode) {
      var f = fileByPath(p);
      var base = siteUrlFor(p);
      if (!p || p.charAt(p.length - 1) === "/") return base;
      if (mode === "source") return base + "?view=source&embed=1";
      if (mode === "raw") return base + "?raw=1";
      if (f && f.kind === "html") return base;
      return base + "?view=1&embed=1";
    }

    function renderTools(p, mode) {
      clear(tools);
      clear(info);
      var f = fileByPath(p);
      var isDir = !p || p.charAt(p.length - 1) === "/";
      var kind = f ? f.kind : null;
      var url = siteUrlFor(p);
      function tab(label, m, enabled) {
        if (!enabled) return null;
        return h("button", {
          type: "button",
          role: "tab",
          "aria-selected": mode === m ? "true" : "false",
          text: label,
          onclick: function () {
            go(p, m, true);
          },
        });
      }
      if (!isDir) {
        add(
          tools,
          h(
            "div",
            { class: "dw-vtabs", role: "tablist", "aria-label": "View mode" },
            tab(kind === "html" ? "Page" : kind === "binary" || kind === "archive" || kind === "wasm" || kind === "model3d" ? "Info" : "Rendered", "view", true),
            tab("Source", "source", !kind || TEXT_KINDS.indexOf(kind) >= 0),
            tab("Raw", "raw", true),
          ),
        );
      }
      add(
        tools,
        h(
          "div",
          { class: "dw-row" },
          !isDir && f && authed() ? h("button", { type: "button", class: "dw-btn small", text: "Download", onclick: function (ev) { downloadFile(slug, p, null, ev.currentTarget); } }) : !isDir ? h("a", { class: "dw-btn small", href: url + "?download=1", text: "Download" }) : null,
          !isDir && f && TEXT_KINDS.indexOf(f.kind) >= 0 && f.size <= 5 * 1024 * 1024
            ? h("button", {
                type: "button",
                class: "dw-btn small",
                text: "Copy text",
                onclick: async function (ev) {
                  var btn = ev.currentTarget;
                  try {
                    var res = authed() ? await api("/sites/" + encodeURIComponent(slug) + "/files/" + encodePath(p), { raw: true }) : await fetch(url + "?raw=1");
                    copyText(await res.text(), btn);
                  } catch (e) {
                    toast(e.message, true);
                  }
                },
              })
            : null,
          h("button", { type: "button", class: "dw-btn small", text: "Copy link", onclick: function (ev) { copyText(url, ev.currentTarget); } }),
          h("a", { class: "dw-btn small", href: url, target: "_blank", rel: "noopener", text: "Open" }),
        ),
      );
      add(
        info,
        h("span", { class: "dw-mono", text: p || "/" }),
        f ? h("span", { class: "dw-muted", text: " · " + bytes(f.size) + " · " + f.contentType.split(";")[0] }) : null,
      );
    }

    function go(p, mode, push) {
      current = p;
      mode = mode || "view";
      var src = viewSrc(p, mode);
      if (frame.src !== src) {
        // A fresh iframe instead of a new src: changing src would add a history entry
        // inside the frame, and Back would then step through the frame, not the viewer.
        var next = frame.cloneNode(false);
        next.src = src;
        next.title = "Preview of " + (p || slug);
        frame.replaceWith(next);
        frame = next;
      }
      renderTools(p, mode);
      $$("a[data-path]", tree).forEach(function (a) {
        if (a.getAttribute("data-path") === p) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      });
      var url = "/v/" + encodeURIComponent(slug) + "/" + encodePath(p) + (mode !== "view" ? "?mode=" + mode : "");
      if (push) history.pushState({ p: p, mode: mode }, "", url);
      d.title = (p.split("/").pop() || slug) + " · " + slug + " · " + boot.instanceName;
    }

    function buildTree(files) {
      // Prototype-less directory maps: legal names like __proto__ or toString are own data, never methods.
      var root = { dirs: Object.create(null), files: [] };
      files.forEach(function (f) {
        var parts = f.path.split("/");
        var node = root;
        for (var i = 0; i < parts.length - 1; i++) {
          var seg = parts[i];
          if (!Object.hasOwn(node.dirs, seg)) node.dirs[seg] = { dirs: Object.create(null), files: [] };
          node = node.dirs[seg];
        }
        node.files.push(f);
      });
      return root;
    }
    function renderNode(node, prefix, depth) {
      var ul = h("ul", { "aria-label": depth ? null : "Files of " + slug });
      Object.keys(node.dirs)
        .sort()
        .forEach(function (name) {
          var path = prefix + name + "/";
          var open = smallSite || current.indexOf(path) === 0;
          ul.appendChild(h("li", {}, h("details", { open: open }, h("summary", { text: name }), renderNode(node.dirs[name], path, depth + 1))));
        });
      node.files
        .slice()
        .sort(function (a, b) {
          return a.path.localeCompare(b.path);
        })
        .forEach(function (f) {
          var name = f.path.split("/").pop();
          ul.appendChild(
            h(
              "li",
              {},
              h("a", {
                href: "/v/" + encodeURIComponent(slug) + "/" + encodePath(f.path),
                "data-path": f.path,
                "data-kind": f.kind,
                title: f.path + " · " + bytes(f.size),
                text: name,
                onclick: function (e) {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
                  e.preventDefault();
                  go(f.path, "view", true);
                },
              }),
            ),
          );
        });
      return ul;
    }

    window.addEventListener("popstate", function (e) {
      var st = e.state || {};
      go(st.p !== undefined ? st.p : P.path || "", st.mode || "view", false);
    });

    var mode = new URLSearchParams(location.search).get("mode") || "view";
    renderTools(current, mode);
    if (!authed()) {
      clear(tree);
      add(tree, h("div", { class: "dw-tree-note" }, h("p", { text: "Sign in to browse every file of this site." }), h("a", { class: "dw-btn small primary", href: signInHref(location.pathname + location.search), text: "Sign in" })));
      return;
    }
    try {
      manifest = await api("/sites/" + encodeURIComponent(slug) + "/files");
    } catch (e) {
      clear(tree);
      add(tree, h("div", { class: "dw-tree-note" }, errorBox(e, "Could not list files")));
      return;
    }
    var smallSite = manifest.files.length <= 40;
    var filter = h("input", { class: "dw-input", type: "search", placeholder: "Filter files", "aria-label": "Filter files" });
    // Display names for the manifest's server-derived kinds (mirrors KIND_LABELS
    // in @dropway/core). This labels values; it never classifies files itself.
    var KIND_LABELS = {
      html: "HTML page", markdown: "Markdown", image: "Image", svg: "SVG image", pdf: "PDF document",
      video: "Video", audio: "Audio", json: "JSON", csv: "Table", code: "Code", text: "Text",
      notebook: "Jupyter notebook", model3d: "3D model", font: "Font", archive: "Archive",
      wasm: "WebAssembly", binary: "Binary file",
    };
    function kindLabel(kind) {
      if (KIND_LABELS[kind]) return KIND_LABELS[kind];
      var words = String(kind).replace(/[_-]+/g, " ").trim();
      return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(kind);
    }
    var kinds = [];
    manifest.files.forEach(function (f) {
      if (f && f.kind && kinds.indexOf(f.kind) < 0) kinds.push(f.kind);
    });
    kinds.sort();
    var kindOptions = [h("option", { value: "", text: "All" })];
    kinds.forEach(function (k) {
      kindOptions.push(h("option", { value: k, text: kindLabel(k) }));
    });
    var kindSel = h("select", { id: "dw-kind", class: "dw-select", "aria-label": "File kind" }, kindOptions);
    var reset = h("button", { type: "button", class: "dw-btn small", text: "Clear" });
    var matchCount = h("span", { class: "dw-small dw-muted", role: "status", text: "" });
    var emptyNote = h("div", { class: "dw-tree-note", text: "", hidden: true });
    var treeBox = h("div", { class: "dw-treebox" }, renderNode(buildTree(manifest.files), "", 0));
    function applyFilter() {
      var q = filter.value.trim().toLowerCase();
      var kind = kindSel.value;
      var filtering = !!(q || kind);
      var total = manifest.files.length;
      var matching = 0;
      $$("a[data-path]", treeBox).forEach(function (a) {
        var show = (!q || a.getAttribute("data-path").toLowerCase().indexOf(q) >= 0) && (!kind || a.getAttribute("data-kind") === kind);
        a.parentNode.hidden = !show;
        if (show) matching++;
      });
      // Innermost branches first, so each parent sees its children's settled state.
      $$("details", treeBox).reverse().forEach(function (x) {
        var hasMatch = $$("a[data-path]", x).some(function (a) {
          return !a.parentNode.hidden;
        });
        x.parentNode.hidden = filtering && !hasMatch;
        if (filtering && hasMatch) x.open = true;
      });
      matchCount.textContent = matching + " of " + plural(total, "file");
      emptyNote.hidden = matching > 0;
      emptyNote.textContent = total === 0 ? "No files in this version" : "No matching files";
    }
    filter.addEventListener("input", applyFilter);
    kindSel.addEventListener("change", applyFilter);
    reset.addEventListener("click", function () {
      filter.value = "";
      kindSel.value = "";
      applyFilter();
    });
    applyFilter();
    clear(tree);
    add(
      tree,
      h("div", { class: "dw-tree-head" }, h("a", { class: "dw-title", href: "/dashboard/sites/" + encodeURIComponent(slug), text: slug }), h("span", { class: "dw-small dw-muted", text: manifest.version ? "v" + manifest.version.number + " · " + plural(manifest.files.length, "file") : "No live version" })),
      filter,
      h("label", { class: "dw-label", for: "dw-kind", text: "File kind" }),
      kindSel,
      h("div", { class: "dw-row" }, reset, matchCount),
      emptyNote,
      treeBox,
    );
    go(current, mode, false);
    // Push entries carry {p, mode}; record the same for the loaded entry so
    // Back restores the prior file and view mode instead of losing the mode.
    history.replaceState({ p: current, mode: mode }, "");
    var cur = $("a[aria-current]", tree);
    if (cur) cur.scrollIntoView({ block: "nearest" });
  };

  // ------------------------------------------------------------------ start

  wireCopyButtons(d);
  var start = pages[d.body.getAttribute("data-page")];
  /** With uiSlots.session and no key in this browser, ask the API whether a cookie session is live first. */
  async function probeSession() {
    if (!SESSION || getKey()) return;
    try {
      var res = await fetch(boot.api + "/me", { headers: { "X-Kofra-Client": "dashboard/1" } });
      if (res.ok) {
        var m = await res.json();
        sessionOk = !!m && m.principal === "member";
      }
    } catch (e) {}
  }
  if (d.body.getAttribute("data-page") === "login" || !SESSION || getKey()) {
    // Nothing to probe (or the sign-in page, whose forms must work at once): start now.
    if (start) start();
    else renderAccount();
  } else {
    probeSession().then(function () {
      if (start) start();
      else renderAccount();
    });
  }

}
