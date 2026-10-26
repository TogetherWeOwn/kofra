import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  DropwayClient,
  DropwayError,
  movedTo,
  normaliseApi,
  VERSION,
  type FetchLike,
} from "../src/index.ts";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

function stubFetch(handler: (req: Request) => Response | Promise<Response>): FetchLike & { requests: Request[] } {
  const requests: Request[] = [];
  const fetch = (async (req: Request) => {
    requests.push(req);
    return handler(req);
  }) as FetchLike & { requests: Request[] };
  fetch.requests = requests;
  return fetch;
}

async function caught(promise: Promise<unknown>): Promise<DropwayError> {
  try {
    await promise;
    expect.unreachable("expected the call to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(DropwayError);
    return e as DropwayError;
  }
}

describe("normaliseApi", () => {
  it("accepts origins, hosts and URLs with an API suffix", () => {
    expect(normaliseApi("https://kofra.test/")).toBe("https://kofra.test");
    expect(normaliseApi("kofra.test")).toBe("https://kofra.test");
    expect(normaliseApi("https://kofra.test/api/v1")).toBe("https://kofra.test");
    expect(normaliseApi("localhost:8787")).toBe("http://localhost:8787");
  });

  it("refuses empty and non-http(s) input", () => {
    expect(() => normaliseApi("  ")).toThrowError(DropwayError);
    expect(() => normaliseApi("ftp://kofra.test")).toThrowError(DropwayError);
    try {
      normaliseApi("  ");
      expect.unreachable();
    } catch (e) {
      expect((e as DropwayError).code).toBe("invalid_api_url");
    }
  });
});

describe("movedTo", () => {
  it("reads the successor origin from the Link header", () => {
    const res = new Response("{}", { headers: { Link: '<https://new.test/api/v1/me>; rel="successor-version"' } });
    expect(movedTo(res, "https://old.test")).toBe("https://new.test");
    expect(movedTo(new Response("{}"), "https://old.test")).toBeNull();
    expect(movedTo(res, "https://new.test")).toBeNull();
  });
});

describe("DropwayError", () => {
  it("carries code, hint, details, status and request id", () => {
    const e = new DropwayError({ code: "version_conflict", message: "moved", hint: "refetch", status: 409, requestId: "r1", details: { a: 1 }, retryable: false });
    expect(e.toJSON()).toEqual({
      code: "version_conflict",
      message: "moved",
      hint: "refetch",
      status: 409,
      retryable: false,
      details: { a: 1 },
      requestId: "r1",
    });
  });

  it("omits recovery metadata it was not constructed with", () => {
    const e = new DropwayError({ code: "site_not_found", message: "gone", status: 404, retryable: false });
    expect(e.retryAfterSeconds).toBeUndefined();
    expect(e.docs).toBeUndefined();
    expect(e.next).toBeUndefined();
    expect(e.toJSON()).toEqual({ code: "site_not_found", message: "gone", status: 404, retryable: false });
  });

  it("keeps explicit recovery metadata in toJSON, including null delay, zero and an empty next array", () => {
    const next = [{ tool: "get_version", args: { site: "s" }, why: "inspect" }];
    const full = new DropwayError({ code: "c", message: "m", status: 409, retryable: false, retryAfterSeconds: 0, docs: "/docs/errors#c", next });
    expect(full.toJSON()).toEqual({ code: "c", message: "m", status: 409, retryable: false, retryAfterSeconds: 0, docs: "/docs/errors#c", next });
    const empty = new DropwayError({ code: "c", message: "m", status: 404, retryable: false, retryAfterSeconds: null, docs: "/docs/errors", next: [] });
    expect(JSON.parse(JSON.stringify(empty))).toEqual({ code: "c", message: "m", status: 404, retryable: false, retryAfterSeconds: null, docs: "/docs/errors", next: [] });
  });
});

describe("DropwayClient transport", () => {
  it("keeps VERSION in sync with package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });

  it("builds API urls and sends attribution plus auth headers", async () => {
    const fetch = stubFetch(() => json({ ok: true }));
    const client = new DropwayClient({ api: "https://kofra.test", token: "dw_x", fetch, client: "probe/1" });
    expect(client.url("/sites")).toBe("https://kofra.test/api/v1/sites");
    expect(client.url("https://other.test/x")).toBe("https://other.test/x");
    await client.get("/sites");
    const req = fetch.requests[0]!;
    expect(req.headers.get("Authorization")).toBe("Bearer dw_x");
    expect(req.headers.get("X-Kofra-Client")).toBe("probe/1");
    expect(req.headers.get("X-Dropway-Client")).toBe("probe/1"); // rebrand:keep (legacy header compat)
  });

  it("defaults the client name to the package version", async () => {
    const fetch = stubFetch(() => json({}));
    await new DropwayClient({ api: "https://kofra.test", token: null, fetch }).get("/sites");
    expect(fetch.requests[0]!.headers.get("X-Kofra-Client")).toBe(`dropway-client/${VERSION}`);
  });

  it("maps the error envelope to a DropwayError", async () => {
    const fetch = stubFetch(() =>
      json({ error: { code: "slug_taken", message: "taken", hint: "pick another" }, requestId: "r1" }, 409),
    );
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch });
    const e = await caught(client.get("/sites"));
    expect(e).toBeInstanceOf(DropwayError);
    expect(e.code).toBe("slug_taken");
    expect(e.hint).toBe("pick another");
    expect(e.status).toBe(409);
    expect(e.requestId).toBe("r1");
    expect(e.retryable).toBe(false);
  });

  it("maps non-JSON failures to http_* errors", async () => {
    const fetch = stubFetch(() => new Response("<html>nope</html>", { status: 404 }));
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch });
    const e = await caught(client.get("/sites"));
    expect(e.code).toBe("http_404");
    expect(e.status).toBe(404);
  });

  it("retries 429s after Retry-After and gives up past the cap", async () => {
    let calls = 0;
    const fetch = stubFetch(() => {
      calls++;
      return calls < 3
        ? json({ error: { code: "rate_limited", message: "slow down" } }, 429, { "Retry-After": "0" })
        : json({ ok: true });
    });
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch, backoffMs: 1 });
    await expect(client.get("/sites")).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(3);

    const capped = stubFetch(() => json({ error: { code: "rate_limited", message: "slow" } }, 429, { "Retry-After": "9999" }));
    const e = await caught(
      new DropwayClient({ api: "https://kofra.test", token: null, fetch: capped, backoffMs: 1 }).get("/sites"),
    );
    expect(e.code).toBe("rate_limited");
    expect(capped.requests.length).toBe(1);
  });

  it("retries 429s for unsafe methods too, within the cap (5xx/network stay safe-only)", async () => {
    let posts = 0;
    const fetch = stubFetch(() => {
      posts++;
      return posts < 2
        ? json({ error: { code: "rate_limited", message: "slow down" } }, 429, { "Retry-After": "0" })
        : json({ ok: true });
    });
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch, attempts: 3, backoffMs: 1 });
    await expect(client.post("/sites", {})).resolves.toMatchObject({ status: 200 });
    expect(posts).toBe(2);

    let unsafe = 0;
    const failing = stubFetch(() => {
      unsafe++;
      return json({ error: { code: "internal_error", message: "boom" } }, 503);
    });
    await new DropwayClient({ api: "https://kofra.test", token: null, fetch: failing, attempts: 3, backoffMs: 1 }).post("/sites", {}).catch(() => {});
    expect(unsafe).toBe(1);
  });

  it("retries network failures on safe methods only", async () => {
    const getFetch = stubFetch(() => {
      throw new Error("boom");
    });
    const getClient = new DropwayClient({ api: "https://kofra.test", token: null, fetch: getFetch, attempts: 2, backoffMs: 1 });
    const e = await caught(getClient.get("/sites"));
    expect(e.code).toBe("network_error");
    expect(e.retryable).toBe(true);
    expect(getFetch.requests.length).toBe(2);

    let posts = 0;
    const postFetch = stubFetch(() => {
      posts++;
      throw new Error("boom");
    });
    const postClient = new DropwayClient({ api: "https://kofra.test", token: null, fetch: postFetch, attempts: 3, backoffMs: 1 });
    await postClient.post("/sites", {}).catch(() => {});
    expect(posts).toBe(1);
  });

  it("notifies onMoved once", async () => {
    const fetch = stubFetch(() =>
      json({}, 200, { Link: '<https://new.test/x>; rel="successor-version"' }),
    );
    const onMoved = vi.fn();
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch, onMoved });
    await client.get("/a");
    await client.get("/b");
    expect(onMoved).toHaveBeenCalledTimes(1);
    expect(onMoved).toHaveBeenCalledWith("https://new.test");
  });

  it("sends the idempotency key when given", async () => {
    const fetch = stubFetch(() => json({}));
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch });
    await client.post("/sites", {}, { idempotencyKey: "k1" });
    expect(fetch.requests[0]!.headers.get("Idempotency-Key")).toBe("k1");
  });

  it("sends a JSON body on byte reads that take one", async () => {
    const fetch = stubFetch(async (req) => new Response(await req.text(), { headers: { "Content-Type": "text/plain" } }));
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch });
    const res = await client.requestBytes("POST", "/bytes", { json: { a: 1 } });
    expect(fetch.requests[0]!.headers.get("Content-Type")).toBe("application/json");
    expect(new TextDecoder().decode(res.data)).toBe('{"a":1}');
  });
});

describe("DropwayClient typed calls", () => {
  it("substitutes and encodes path parameters on GET without a body", async () => {
    const fetch = stubFetch(() => json({ slug: "a/b" }));
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch });
    const out = await client.getSite({ slug: "a/b" });
    expect(out.slug).toBe("a/b");
    const req = fetch.requests[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://kofra.test/api/v1/sites/a%2Fb");
  });

  it("sends non-path GET input as a query string", async () => {
    const fetch = stubFetch(() => json({}));
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch });
    await client.listSites({ limit: 5 });
    expect(fetch.requests[0]!.url).toBe("https://kofra.test/api/v1/sites?limit=5");
  });

  it("posts JSON bodies without path parameters", async () => {
    const fetch = stubFetch(async (req) => json({ seen: await req.json(), url: req.url }));
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch });
    const out = (await client.updateSiteFiles({ slug: "s", files: [] })) as unknown as { seen: unknown; url: string };
    expect(out.url).toBe("https://kofra.test/api/v1/sites/s/files");
    expect(out.seen).toEqual({ files: [] });
  });

  it("refuses to call with a missing path parameter before any fetch", async () => {
    const fetch = stubFetch(() => json({}));
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch });
    const e = await caught(client.getSite({} as unknown as { slug: string }));
    expect(e).toBeInstanceOf(DropwayError);
    expect(e.code).toBe("invalid_input");
    expect(fetch.requests.length).toBe(0);
  });

  it("uploads raw bytes and reads them back", async () => {
    const put = stubFetch(async (req) => json({ stored: (await req.arrayBuffer()).byteLength }));
    const client = new DropwayClient({ api: "https://kofra.test", token: null, fetch: put });
    const sha = "a".repeat(64);
    const stored = (await client.uploadBlob({ sha256: sha }, new TextEncoder().encode("hello"))) as unknown as { stored: number };
    expect(stored.stored).toBe(5);
    expect(put.requests[0]!.method).toBe("PUT");
    expect(put.requests[0]!.url).toBe(`https://kofra.test/api/v1/blobs/${sha}`);

    const get = stubFetch(() => new Response("hello", { headers: { "Content-Type": "text/plain" } }));
    const bytes = await new DropwayClient({ api: "https://kofra.test", token: null, fetch: get }).getFileBytes({
      slug: "s",
      path: "a.txt",
    });
    expect(new TextDecoder().decode(bytes.data)).toBe("hello");
    expect(bytes.contentType).toBe("text/plain");
  });
});
