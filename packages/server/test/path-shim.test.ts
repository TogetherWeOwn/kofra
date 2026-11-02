import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { pathShimScript } from "../src/path-shim.ts";

/**
 * Runs the injected path-mode shim against stub browser APIs (Node vm), to check
 * which URLs it rewrites. The real-browser check is ops' Playwright run against a
 * deployed instance; the Workers test runtime cannot evaluate scripts.
 */

type Call = [string, ...unknown[]];

function accessor(proto: object, prop: string) {
  Object.defineProperty(proto, prop, {
    configurable: true,
    enumerable: true,
    get(this: Record<string, unknown>) {
      return this[`_${prop}`];
    },
    set(this: Record<string, unknown>, v: unknown) {
      this[`_${prop}`] = v;
    },
  });
}

function browser(base: string, keep: string[]) {
  const calls: Call[] = [];
  let observer: ((records: Array<{ addedNodes: unknown[] }>) => void) | null = null;
  class Element {
    localName = "";
    nodeType = 1;
    attrs: Record<string, string> = {};
    children: Element[] = [];
    setAttribute(n: string, v: string) {
      this.attrs[n] = v;
    }
    setAttributeNS(_ns: string, n: string, v: string) {
      this.attrs[n] = v;
    }
    getAttribute(n: string) {
      return n in this.attrs ? this.attrs[n]! : null;
    }
    querySelectorAll() {
      return this.children;
    }
  }
  // URL properties are defined at run time (accessor()), so the stubs are typed loosely.
  const el = (C: new () => Element, tag: string) => (): Element & Record<string, any> => Object.assign(new C(), { localName: tag });
  class HTMLImageElement extends Element {}
  class HTMLAnchorElement extends Element {}
  class HTMLMediaElement extends Element {}
  class HTMLScriptElement extends Element {}
  accessor(HTMLImageElement.prototype, "src");
  accessor(HTMLImageElement.prototype, "srcset");
  accessor(HTMLAnchorElement.prototype, "href");
  accessor(HTMLMediaElement.prototype, "src");
  accessor(HTMLScriptElement.prototype, "src");
  const g: Record<string, unknown> = {
    fetch: (i: unknown) => void calls.push(["fetch", i]),
    Request: class {
      url: unknown;
      constructor(u: unknown) {
        this.url = u;
      }
    },
    XMLHttpRequest: class {
      open(m: string, u: unknown) {
        calls.push(["xhr", m, u]);
      }
    },
    EventSource: class {
      constructor(u: unknown) {
        calls.push(["sse", u]);
      }
    },
    navigator: { sendBeacon: (u: unknown) => calls.push(["beacon", u]) > 0 },
    open: (u: unknown) => void calls.push(["open", u]),
    URL,
    Element,
    HTMLImageElement,
    HTMLAnchorElement,
    HTMLMediaElement,
    HTMLScriptElement,
    MutationObserver: class {
      constructor(cb: typeof observer) {
        observer = cb;
      }
      observe() {}
    },
    document: { documentElement: {} },
  };
  g.window = g;
  vm.createContext(g);
  const script = pathShimScript({ base, keep });
  expect(script.startsWith('<script data-kofra="path-shim">')).toBe(true);
  vm.runInContext(script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""), g);
  return {
    g: g as any,
    calls,
    img: el(HTMLImageElement, "img"),
    a: el(HTMLAnchorElement, "a"),
    video: el(HTMLMediaElement, "video"),
    insert: (...nodes: Element[]) => observer?.([{ addedNodes: nodes }]),
  };
}

describe("path-mode run-time shim", () => {
  it("prefixes root-relative fetch, XHR, Request, EventSource, beacon and window.open URLs", () => {
    const b = browser("/s/demo-site/", ["/s/"]);
    b.g.fetch("/" + "data.json");
    b.g.fetch("/api/items?page=2#x");
    b.g.fetch("  /spaced.json");
    new b.g.XMLHttpRequest().open("GET", "/xhr.json");
    expect(new b.g.Request("/req.json").url).toBe("/s/demo-site/req.json");
    new b.g.EventSource("/events");
    b.g.navigator.sendBeacon("/beacon");
    b.g.open("/popup.html");
    expect(b.calls).toEqual([
      ["fetch", "/s/demo-site/data.json"],
      ["fetch", "/s/demo-site/api/items?page=2#x"],
      ["fetch", "/s/demo-site/spaced.json"],
      ["xhr", "GET", "/s/demo-site/xhr.json"],
      ["sse", "/s/demo-site/events"],
      ["beacon", "/s/demo-site/beacon"],
      ["open", "/s/demo-site/popup.html"],
    ]);
  });

  it("leaves relative, absolute, protocol-relative, already-prefixed and kept URLs alone", () => {
    const b = browser("/s/demo-site/", ["/s/"]);
    const untouched = [
      "data.json",
      "./data.json",
      "../x.json",
      "https://example.com/x.json",
      "//cdn.example.com/x.js",
      "/\\evil.example/x",
      "/s/demo-site/data.json",
      "/s/demo-site",
      "/s/demo-site?x=1",
      "/s/other-site/data.json",
      "data:text/plain,hi",
    ];
    for (const u of untouched) b.g.fetch(u);
    const url = new URL("https://host.example/abs.json");
    b.g.fetch(url);
    expect(b.calls.map((c) => c[1])).toEqual([...untouched, url]);
  });

  it("on a sites-only origin (no kept prefixes) every root-relative URL is the site's", () => {
    const b = browser("/demo-site/", []);
    b.g.fetch("/s/thing.json");
    b.g.fetch("/demo-site/ok.json");
    expect(b.calls.map((c) => c[1])).toEqual(["/demo-site/s/thing.json", "/demo-site/ok.json"]);
  });

  it("rewrites element URL properties, srcset and setAttribute for URL-carrying elements only", () => {
    const b = browser("/s/demo-site/", ["/s/"]);
    const img = b.img();
    img.src = "/img/a.png";
    expect(img.src).toBe("/s/demo-site/img/a.png");
    img.srcset = "/img/a.png 1x, /img/a@2x.png 2x, https://cdn.example/b.png 3x";
    expect(img.srcset).toBe("/s/demo-site/img/a.png 1x, /s/demo-site/img/a@2x.png 2x, https://cdn.example/b.png 3x");
    const video = b.video();
    video.src = "/v.mp4";
    expect(video.src).toBe("/s/demo-site/v.mp4");
    const a = b.a();
    a.setAttribute("href", "/about.html");
    a.setAttribute("title", "/not-a-url");
    expect(a.attrs).toEqual({ href: "/s/demo-site/about.html", title: "/not-a-url" });
    const div = Object.assign(new b.g.Element(), { localName: "div" });
    div.setAttribute("href", "/x");
    expect(div.attrs.href).toBe("/x");
  });

  it("corrects URL attributes of elements inserted later (innerHTML)", () => {
    const b = browser("/s/demo-site/", ["/s/"]);
    const wrapper = Object.assign(new b.g.Element(), { localName: "div" });
    const img = b.img();
    img.attrs.src = "/late.png";
    const ok = b.img();
    ok.attrs.src = "/s/demo-site/fine.png";
    wrapper.children = [img, ok];
    b.insert(wrapper);
    expect(img.attrs.src).toBe("/s/demo-site/late.png");
    expect(ok.attrs.src).toBe("/s/demo-site/fine.png");
  });

  it("embeds its arguments safely inside an inline script", () => {
    const s = pathShimScript({ base: "/s/a</script><b>/", keep: ["/s/"] });
    expect(s.match(/<\/script>/g)).toHaveLength(1);
    expect(s).toContain("\\u003c/script>");
  });
});
