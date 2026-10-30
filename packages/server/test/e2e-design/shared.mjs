// Screenshot-harness helpers shared by the core harness (shots.mjs) and harnesses of embedding apps, exported as
// "@dropway/server/e2e-design" so they are reused, never copied. Plain JavaScript (Node and the browser), no build.

/**
 * Until a smooth scroll to the focused element (normal motion) has started, if it is needed, and come to rest: the
 * page has not moved for 5 frames and the focused element is in the viewport (or 1 s has passed without it getting
 * there, so a stop that never scrolls into view is still measured and reported). At most ~3 s. Run it in the page:
 * page.evaluate(SETTLE).
 */
export const SETTLE = () =>
  new Promise((done) => {
    let last = null;
    let still = 0;
    let n = 0;
    const tick = () => {
      n++;
      const now = `${scrollX},${scrollY}`;
      still = now === last ? still + 1 : 0;
      last = now;
      const r = document.activeElement?.getBoundingClientRect();
      const inView = !r || (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth);
      if ((still >= 5 && (inView || n > 60)) || n > 180) done();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * G7b filmstrip: in each explicit mode, load each target with the app stylesheet held back (1.2 s) and the fonts held
 * back (0.6 s), record every frame the compositor paints (CDP screencast, PNG) until load + 400 ms, and check each
 * frame's dominant colour: dark in Dark, light in Light. A white frame in Dark (or a dark one in Light) is a flash of
 * the wrong mode, whatever the computed styles said. The tab shows the page once first, so the recording starts from
 * it: a fresh tab's about:blank is painted in the OS scheme (the browser's frame, not the page's), and the compositor
 * can hand one over after the new document commits. Routing turns the HTTP cache off, so the second load is held
 * back again. The OS scheme is the opposite of the mode, so only the explicit choice can paint the mode.
 *
 * - targets: [{ id, url(mode), ...anything prepare needs }]
 * - respond(request): the response for a routed request ({ status, headers, body }), or null to abort it
 * - prepare(context, mode, target): optional, e.g. cookies for the mode and a target's session
 * Returns { "filmstrip <id> <mode>": { pass, detail } }.
 */
export async function filmstrip(browser, { targets, respond, prepare, contextOptions = {}, modes = ["light", "dark"] }) {
  const out = {};
  for (const t of targets) {
    for (const mode of modes) {
      const key = `filmstrip ${t.id} ${mode}`;
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...contextOptions, colorScheme: mode === "dark" ? "light" : "dark", reducedMotion: "reduce", ignoreHTTPSErrors: true });
      try {
        await context.route("**/*", async (route) => {
          const res = await respond(route.request());
          if (!res) return route.abort();
          const path = new URL(route.request().url()).pathname;
          if (path.startsWith("/__dropway/ui/") && path.endsWith(".css")) await sleep(1200);
          if (path.startsWith("/__dropway/fonts/")) await sleep(600);
          await route.fulfill(res);
        });
        if (prepare) await prepare(context, mode, t);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        const url = t.url(mode);
        await page.goto(url, { waitUntil: "load", timeout: 30000 });
        const frames = [];
        cdp.on("Page.screencastFrame", (f) => {
          frames.push(f.data);
          cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
        });
        await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 360, maxHeight: 225 });
        await page.goto(url, { waitUntil: "load", timeout: 30000 });
        await page.waitForTimeout(400);
        await cdp.send("Page.stopScreencast").catch(() => {});
        const colours = await dominantColours(browser, frames);
        const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const wrong = colours.filter((c) => (mode === "dark" ? lum(c) > 0.25 : lum(c) < 0.6));
        out[key] = { pass: frames.length > 0 && wrong.length === 0, detail: { frames: frames.length, colours: [...new Set(colours.map((c) => `rgb(${c.join(",")})`))].slice(0, 6), wrong: wrong.length } };
      } catch (e) {
        out[key] = { pass: false, detail: String(e).slice(0, 200) };
      } finally {
        await context.close();
      }
    }
  }
  return out;
}

/** The most common colour of each base64 PNG (decoded on a canvas, 4-bit buckets), as [r, g, b]. */
export async function dominantColours(browser, frames) {
  if (!frames.length) return [];
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    return await page.evaluate(async (list) => {
      const out = [];
      for (const b64 of list) {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        const counts = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const [k] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        out.push([((k >> 8) & 15) * 17, ((k >> 4) & 15) * 17, (k & 15) * 17]);
      }
      return out;
    }, frames);
  } finally {
    await context.close();
  }
}

/**
 * WCAG 2.1 SC 1.4.12 Text Spacing: the standard override (line height 1.5, letter spacing 0.12em, word spacing
 * 0.16em, paragraph spacing 2em), as the W3C's text-spacing bookmarklet applies it.
 */
export const TEXT_SPACING_CSS = "*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";

/**
 * Text cut off by its box (run in the page): every visible element with text whose content is wider (or taller)
 * than a box that clips it (overflow hidden or clip, or an ellipsis). Scroll boxes (overflow auto) are not clipped:
 * their content can be reached. Each element keeps an id across calls, so a harness can list what an override
 * newly cut off: run it, apply TEXT_SPACING_CSS, run it again, and compare the ids (textSpacingLoss does that).
 */
export const CLIPPED_TEXT = () => {
  const out = [];
  let n = 0;
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    n++;
    if (el.closest("svg, iframe, video, audio, canvas, select, textarea, input, script, style, noscript, [aria-hidden=true], .k-sr, .k-skip")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const clipX = cs.overflowX === "hidden" || cs.overflowX === "clip";
    const clipY = cs.overflowY === "hidden" || cs.overflowY === "clip";
    const ellipsis = cs.textOverflow === "ellipsis";
    if (!clipX && !clipY && !ellipsis) continue;
    const text = (el.innerText || "").trim();
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) continue;
    const overX = (clipX || ellipsis) && el.scrollWidth > el.clientWidth + 1;
    const overY = clipY && el.scrollHeight > el.clientHeight + 1;
    if (!overX && !overY) continue;
    el.__kclip ??= `t${n}`;
    out.push({ id: el.__kclip, el: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}`.slice(0, 80), text: text.slice(0, 40), x: overX ? `${el.scrollWidth}>${el.clientWidth}` : null, y: overY ? `${el.scrollHeight}>${el.clientHeight}` : null });
  }
  return out;
};

/** 1.4.12 on a loaded page: what TEXT_SPACING_CSS newly cuts off ([] = nothing lost). The override stays applied. */
export async function textSpacingLoss(page) {
  const before = new Set((await page.evaluate(CLIPPED_TEXT)).map((c) => c.id));
  await page.addStyleTag({ content: TEXT_SPACING_CSS });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return (await page.evaluate(CLIPPED_TEXT)).filter((c) => !before.has(c.id));
}
