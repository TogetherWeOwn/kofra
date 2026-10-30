import { beforeEach, describe, expect, it } from "vitest";
import { form, freshInstance, type Instance } from "./helpers";

const METHODS = ["GET", "HEAD"] as const;

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

async function publishRedirect(status = 302, extraFiles: Record<string, string> = {}) {
  const published = await dw.json("/api/v1/publish", {
    method: "POST",
    key: dw.ownerKey,
    body: form({
      "index.html": "<p>home</p>",
      "static/index-abc12345.js": "export const destination = true;",
      _redirects: `/assets/* /static/:splat ${status}\n`,
      ...extraFiles,
    }),
  });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  return published.body.slug as string;
}

async function unlock(slug: string) {
  const locked = await dw.json(`/api/v1/sites/${slug}/access`, {
    method: "PUT",
    key: dw.ownerKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", password: "redirect-test-password" }),
  });
  expect(locked.status, JSON.stringify(locked.body)).toBe(200);
  const login = await dw.call(`/s/${slug}/__dropway/password`, {
    method: "POST",
    headers: {
      Accept: "text/html",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=redirect-test-password&next=%2Fassets%2Findex-abc12345.js",
  });
  expect(login.status).toBe(303);
  expect(login.headers.get("set-cookie")).toBeTruthy();
  return login.headers.get("set-cookie")!.split(";")[0]!;
}

describe.each([301, 302, 307, 308])("configured %i redirect cache policy (SRV-05)", (status) => {
  it.each(METHODS)("%s revalidates a fingerprinted-looking redirect without a source file", async (method) => {
    const slug = await publishRedirect(status);
    const response = await dw.call(`/s/${slug}/assets/index-abc12345.js?from=source&tag=a%2Fb`, { method });
    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBe(`/s/${slug}/static/index-abc12345.js?from=source&tag=a%2Fb`);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });
});

describe("configured redirect cache boundaries", () => {
  it.each(METHODS)("%s revalidates a redirect that shadows a fingerprinted file", async (method) => {
    const slug = await publishRedirect(302, { "assets/index-abc12345.js": "export const original = true;" });
    const response = await dw.call(`/s/${slug}/assets/index-abc12345.js`, { method });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/s/${slug}/static/index-abc12345.js`);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it.each(METHODS)("%s revalidates an unfingerprinted redirect", async (method) => {
    const slug = await publishRedirect();
    const response = await dw.call(`/s/${slug}/assets/app.js?from=source`, { method });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/s/${slug}/static/app.js?from=source`);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it.each(METHODS)("%s honors a public _headers cache override and the redirect's explicit query", async (method) => {
    const slug = await publishRedirect(302, {
      _redirects: "/assets/* /static/:splat?from=rule 302\n",
      _headers: "/assets/*\n  Cache-Control: public, max-age=60\n  X-Cache-Rule: matched\n",
    });
    const response = await dw.call(`/s/${slug}/assets/index-abc12345.js?from=source&discard=yes`, { method });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/s/${slug}/static/index-abc12345.js?from=rule`);
    expect(response.headers.get("x-cache-rule")).toBe("matched");
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it.each(METHODS)("%s keeps an unlocked password-gated redirect private, no-store", async (method) => {
    const slug = await publishRedirect();
    const cookie = await unlock(slug);
    const response = await dw.call(`/s/${slug}/assets/index-abc12345.js?from=source`, { method, headers: { Cookie: cookie } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/s/${slug}/static/index-abc12345.js?from=source`);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(METHODS)("%s refuses a public _headers cache override on an unlocked password-gated redirect", async (method) => {
    const slug = await publishRedirect(302, {
      _headers: "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Cache-Rule: matched\n",
    });
    const cookie = await unlock(slug);
    const response = await dw.call(`/s/${slug}/assets/index-abc12345.js?from=source`, { method, headers: { Cookie: cookie } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/s/${slug}/static/index-abc12345.js?from=source`);
    expect(response.headers.get("x-cache-rule")).toBe("matched");
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(METHODS)("%s still serves an ordinary fingerprinted file as immutable", async (method) => {
    const slug = await publishRedirect();
    const response = await dw.call(`/s/${slug}/static/index-abc12345.js`, { method });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe(method === "HEAD" ? "" : "export const destination = true;");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
