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
          h("div", { class: "dw-row" }, h("button", { class: "dw-btn", value: "cancel", text: "Cancel" }), ok),
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
      return { path: it.path.slice(first.length + 1), file: it.file };
    });
  }

  function readEntry(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(
          function (f) {
            out.push({ path: prefix + f.name, file: f });
            resolve();
          },
          function () {
            resolve();
          },
        );
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        var next = function () {
          reader.readEntries(
            function (batch) {
              if (!batch.length) {
                Promise.all(
                  all.map(function (e) {
                    return readEntry(e, prefix + entry.name + "/", out);
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
      return Array.prototype.map.call(dt.files || [], function (f) {
        return { path: f.name, file: f };
      });
    }
    var out = [];
    await Promise.all(
      entries.map(function (e) {
        return readEntry(e, "", out);
      }),
    );
    return out;
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
    var state = { items: [], skipped: [], busy: false };
    var siteSelect = h("select", { class: "dw-select", id: "dw-pub-site", "aria-label": "Site to update" }, h("option", { value: "", text: "Loading sites…" }));
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
    var zone = h(
      "div",
      { class: "dw-drop", tabindex: "0", role: "button", "aria-label": "Drop a folder, files or a zip here, or press Enter to choose a folder" },
      h("strong", { text: "Drop a folder, files or a .zip" }),
      h("p", { class: "dw-muted dw-small", style: "margin:.25rem 0 .9rem", text: "Files are hashed in your browser; only files the server does not have yet are uploaded." }),
      h(
        "div",
        { class: "dw-row", style: "justify-content:center" },
        h("button", { type: "button", class: "dw-btn", text: "Choose folder", onclick: function (e) { e.stopPropagation(); dirInput.click(); } }),
        h("button", { type: "button", class: "dw-btn", text: "Choose files", onclick: function (e) { e.stopPropagation(); fileInput.click(); } }),
      ),
      dirInput,
      fileInput,
    );

    function setItems(items) {
      var keep = [];
      var skipped = [];
      stripCommonRoot(items).forEach(function (it) {
        var why = ignored(it.path);
        if (why) skipped.push(it.path + " (" + why + ")");
        else keep.push(it);
      });
      state.items = keep;
      state.skipped = skipped;
      clear(result);
      var total = keep.reduce(function (s, it) {
        return s + it.file.size;
      }, 0);
      var zip = keep.length === 1 && /\.zip$/i.test(keep[0].path);
      var hasIndex = keep.some(function (it) {
        return /^(index\.html?|index\.md|readme\.md)$/i.test(it.path);
      });
      clear(summary);
      if (keep.length) {
        add(
          summary,
          h("span", { style: "color:var(--fg);font-weight:600", text: zip ? "1 zip file · " + bytes(total) + " (unpacked on the server)" : plural(keep.length, "file") + " · " + bytes(total) }),
          !zip && keep.length > 1 ? (hasIndex ? " · has an index page" : " · no index.html: the site root will list the files") : "",
          skipped.length ? h("div", { text: "Skipped " + plural(skipped.length, "file") + ": " + skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? "…" : "") }) : null,
        );
      } else if (skipped.length) add(summary, "Every file was skipped: " + skipped.slice(0, 5).join(", "));
      publishBtn.disabled = !keep.length || state.busy;
      clearBtn.hidden = !keep.length;
    }

    zone.addEventListener("click", function () {
      dirInput.click();
    });
    zone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
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
      setItems(await filesFromDrop(e.dataTransfer));
    });
    dirInput.addEventListener("change", function () {
      setItems(
        Array.prototype.map.call(dirInput.files, function (f) {
          return { path: f.webkitRelativePath || f.name, file: f };
        }),
      );
      dirInput.value = "";
    });
    fileInput.addEventListener("change", function () {
      setItems(
        Array.prototype.map.call(fileInput.files, function (f) {
          return { path: f.name, file: f };
        }),
      );
      fileInput.value = "";
    });
    clearBtn.addEventListener("click", function () {
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

    async function run() {
      if (state.busy || !state.items.length) return;
      state.busy = true;
      publishBtn.disabled = true;
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
          showResult({ slug: slug, unchanged: true, version: dep.deploy });
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
        publishBtn.disabled = !state.items.length;
      }
    }

    function showResult(r) {
      setItems([]);
      clear(result);
      var url = r.url || null;
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
      if (key) {
        modeUpd.checked = true;
        slugInput.value = "";
        loadSites(r.slug);
      }
    }

    async function loadSites(select) {
      if (!key) return;
      try {
        var res = await api("/sites?limit=200");
        clear(siteSelect);
        if (!res.sites.length) add(siteSelect, h("option", { value: "", text: "No sites yet" }));
        res.sites.forEach(function (s) {
          add(siteSelect, h("option", { value: s.slug, text: s.title ? s.title + " (" + s.slug + ")" : s.slug }));
        });
        if (select) siteSelect.value = select;
      } catch (e) {
        clear(siteSelect);
        add(siteSelect, h("option", { value: "", text: "Could not load sites" }));
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
            h("label", { class: "dw-check" }, modeUpd, h("span", { style: "flex:1" }, "A new version of", h("span", { class: "dw-sub" }, "Site"), siteSelect)),
          ),
        );
    slugInput.addEventListener("focus", function () {
      modeNew.checked = true;
    });
    siteSelect.addEventListener("change", function () {
      modeUpd.checked = true;
    });
    add(
      root,
      target,
      opts.compact ? null : h("div", { class: "dw-field" }, h("label", { class: "dw-label", for: "dw-pub-msg", text: "Message" }), message),
      zone,
      h("div", { class: "dw-row", style: "justify-content:space-between;margin-top:.75rem" }, summary, h("div", { class: "dw-row" }, clearBtn, publishBtn)),
      progress,
      status,
      result,
    );
    if (key) loadSites(opts.site);
  }

  // ------------------------------------------------------------------ pages

  var pages = {};

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
    renderAccount();
    var slug = P.slug;
    var root = d.getElementById("dw-site");
    clear(root);
    add(root, skeleton(5));
    var site, versions, files;
    try {
      var r = await Promise.all([api("/sites/" + encodeURIComponent(slug)), api("/sites/" + encodeURIComponent(slug) + "/versions?limit=100")]);
      site = r[0].site;
      versions = r[1].versions;
    } catch (e) {
      clear(root);
      add(root, errorBox(e, "Could not load " + slug), h("a", { class: "dw-btn", href: "/dashboard", text: "Back to sites" }));
      return;
    }
    d.title = (site.title || site.slug) + " · " + boot.instanceName;
    clear(root);
    var filesSection = h("section", { class: "dw-section", id: "files" });
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
        h("a", { class: "dw-btn primary", href: site.url, target: "_blank", rel: "noopener", text: "Open site" }),
      ),
    );

    var vBody = h("tbody");
    versions.forEach(function (v) {
      vBody.appendChild(
        h(
          "tr",
          {},
          h("td", {}, h("strong", { text: "v" + v.number }), " ", v.live ? h("span", { class: "dw-badge live", text: "Live" }) : null),
          h("td", { class: "dw-small" }, v.message ? h("span", { text: v.message }) : h("span", { class: "dw-muted", text: "No message" }), h("span", { class: "dw-sub", text: [v.client, v.source].filter(Boolean).join(" · ") })),
          h("td", { class: "num dw-small" }, plural(v.fileCount, "file"), h("span", { class: "dw-sub", text: bytes(v.totalBytes) })),
          h("td", { class: "num dw-small dw-muted dw-hide-sm", title: v.finalizedAt || v.createdAt, text: ago(v.finalizedAt || v.createdAt) }),
          h(
            "td",
            { class: "act" },
            h("button", { type: "button", class: "dw-btn small", text: "Files", onclick: function () { showFiles(v); filesSection.scrollIntoView({ behavior: "smooth" }); } }),
            " ",
            v.live
              ? null
              : h("button", {
                  type: "button",
                  class: "dw-btn small",
                  text: "Restore",
                  onclick: async function (ev) {
                    var btn = ev.currentTarget;
                    btn.disabled = true;
                    try {
                      await api("/sites/" + encodeURIComponent(slug) + "/versions/" + encodeURIComponent(v.id) + "/restore", { method: "POST" });
                      toast("v" + v.number + " is live again.");
                      pages.site();
                    } catch (e) {
                      toast(e.message, true);
                      btn.disabled = false;
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
                  onclick: async function () {
                    var ok = await confirmBox({ title: "Delete v" + v.number + "?", message: "The version and its file list are removed for good (use this for a version that leaked something). Other versions are not affected.", confirmText: "Delete version" });
                    if (!ok) return;
                    try {
                      await api("/sites/" + encodeURIComponent(slug) + "/versions/" + encodeURIComponent(v.id), { method: "DELETE" });
                      toast("v" + v.number + " deleted.");
                      pages.site();
                    } catch (e) {
                      toast(e.message, true);
                    }
                  },
                }),
          ),
        ),
      );
    });
    var versionsSection = h(
      "section",
      { class: "dw-section" },
      h("header", {}, h("h2", { text: "Versions" }), h("span", { class: "dw-small dw-muted", text: plural(versions.length, "version") + ". Restoring is instant: it only moves the live pointer." })),
      versions.length
        ? h("div", { class: "dw-scroll" }, h("table", { class: "dw-table" }, h("thead", {}, h("tr", {}, h("th", { text: "Version" }), h("th", { text: "Message" }), h("th", { class: "num", text: "Files" }), h("th", { class: "num dw-hide-sm", text: "Published" }), h("th", {}))), vBody))
        : h("div", { class: "dw-empty" }, h("h3", { text: "Nothing published yet" }), h("a", { class: "dw-btn primary", href: "/dashboard/publish?site=" + encodeURIComponent(slug), text: "Publish files" })),
    );

    var filesReq = 0;
    async function showFiles(v) {
      var my = ++filesReq;
      clear(filesSection);
      add(filesSection, h("header", {}, h("h2", { text: "Files in v" + v.number + (v.live ? " (live)" : "") })), skeleton(3));
      var data;
      try {
        // Always pin the selected version by immutable ID: a live-row snapshot
        // may already be stale by the time this request lands.
        data = await api("/sites/" + encodeURIComponent(slug) + "/files?version=" + encodeURIComponent(v.id));
      } catch (e) {
        if (my !== filesReq) return;
        clear(filesSection);
        add(filesSection, h("div", { class: "dw-pad" }, errorBox(e, "Could not load files")));
        return;
      }
      if (my !== filesReq) return;
      // Identity comes from the response, never the clicked row: the live
      // pointer may have moved between selection and retrieval.
      var mv = (data && data.version) || { id: v.id, number: v.number, live: v.live };
      var rows = (data && data.files) || [];
      var filter = h("input", { class: "dw-input", type: "search", placeholder: "Filter files", "aria-label": "Filter files" });
      if (!rows.length) {
        clear(filesSection);
        add(
          filesSection,
          h("header", {}, h("h2", { text: "Files in v" + mv.number + (mv.live ? " (live)" : "") }), h("div", { class: "dw-row" }, h("span", { class: "dw-small dw-muted", text: "0 files" }), filter)),
          h("div", { class: "dw-empty" }, h("h3", { text: "No files in this version" }), h("p", { class: "dw-small", text: "This version has an empty manifest." })),
        );
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
                  if (attempt !== copyReq || my !== filesReq) return;
                  // A separate task makes identical results observable again.
                  copyTimer = setTimeout(function () {
                    if (attempt !== copyReq || my !== filesReq) return;
                    copyStatus.textContent = ok
                      ? "Copied SHA-256 for " + f.path + "."
                      : "Copy failed for " + f.path + ". Select the checksum and copy it yourself.";
                  }, 0);
                });
              },
            }),
            " ",
            h("button", { type: "button", class: "dw-btn small", text: "Download", onclick: function (ev) { downloadFile(slug, f.path, mv.live ? null : mv.id, ev.currentTarget); } }),
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
      function applyFilter() {
        var q = filter.value.trim().toLowerCase();
        items.forEach(function (it) {
          it.row.hidden = q && it.row.getAttribute("data-search").indexOf(q) < 0;
        });
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
        h("header", {}, h("h2", { text: "Files in v" + mv.number + (mv.live ? " (live)" : "") }), h("div", { class: "dw-row" }, h("span", { class: "dw-small dw-muted", text: plural(rows.length, "file") }), sortBar, filter)),
        h("p", { class: "dw-pad dw-small dw-muted", style: "margin:0", text: "SHA-256 manifest checksums for the selected version (v" + mv.number + ", " + mv.id + "). A checksum is not proof of authenticity, provenance, safe content, or independent verification, and does not show the current live download matches — compare it against a trusted source you already have." }),
        h("div", { class: "dw-scroll" }, h("table", { class: "dw-table" }, h("thead", {}, h("tr", {}, sortTh("path", "Path"), sortTh("kind", "Kind", "dw-hide-sm"), sortTh("size", "Size", "num"), h("th", { scope: "col", text: "SHA-256" }), h("th", { scope: "col" }))), tb)),
        copyStatus,
        mv.live ? null : h("p", { class: "dw-pad dw-small dw-muted", style: "margin:0", text: "Older versions are not served publicly. Restore this version to view it on the site, or download single files." }),
      );
      applySort();
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
          s.passwordProtected ? h("button", { type: "button", class: "dw-btn", text: "Remove password", onclick: async function () { await saveSettings({ password: null }, "Password removed."); } }) : null),
        h("p", { class: "dw-help", text: "Visitors must enter it. Changing it signs everyone out." }),
      ),
      h("div", { class: "dw-row" }, h("button", { type: "submit", class: "dw-btn primary", text: "Save settings" })),
    );
    async function saveSettings(body, msg) {
      try {
        await api("/sites/" + encodeURIComponent(slug), { method: "PATCH", body: body });
        toast(msg || "Saved.");
        pages.site();
      } catch (e) {
        toast(e.message + (e.hint ? " " + e.hint : ""), true);
      }
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var f = form.elements;
      var body = { title: f.title.value.trim() || null, description: f.description.value.trim() || null, spa: f.spa.checked, renderMarkdown: f.renderMarkdown.checked, crossOriginIsolation: f.crossOriginIsolation.checked };
      if (f.password.value) body.password = f.password.value;
      saveSettings(body);
    });
    var danger = h(
      "section",
      { class: "dw-section" },
      h("header", {}, h("h2", { text: "Delete site" })),
      h(
        "div",
        { class: "dw-pad dw-row", style: "justify-content:space-between" },
        h("span", { class: "dw-small dw-muted", text: "The URL stops working at once and the name is freed. Files no other site uses are removed by the hourly cleanup." }),
        h("button", {
          type: "button",
          class: "dw-btn danger",
          text: "Delete site",
          onclick: async function () {
            var ok = await confirmBox({ title: "Delete " + slug + "?", message: "Every version goes with it. This cannot be undone from the dashboard.", confirmText: "Delete site", typeToConfirm: slug });
            if (!ok) return;
            try {
              await api("/sites/" + encodeURIComponent(slug), { method: "DELETE" });
              location.href = "/dashboard?deleted=" + encodeURIComponent(slug);
            } catch (e) {
              toast(e.message, true);
            }
          },
        }),
      ),
    );
    add(root, head, versionsSection, filesSection, h("section", { class: "dw-section" }, h("header", {}, h("h2", { text: "Settings" })), form), danger);
    var live = versions.filter(function (v) {
      return v.live;
    })[0];
    if (live) showFiles(live);
    else filesSection.hidden = true;
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
