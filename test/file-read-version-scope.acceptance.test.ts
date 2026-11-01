import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";

const SECRET = "site-two private bytes";

async function publishSecret(dw: Instance) {
  const one = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ site: "site-one", files: [{ path: "secret.txt", content: "site-one bytes" }] }) });
  expect(one.status).toBe(201);
  const two = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ site: "site-two", files: [{ path: "secret.txt", content: SECRET }] }) });
  expect(two.status).toBe(201);
  return { one: one.body.version.id as string, two: two.body.version.id as string };
}

describe("file bytes are read only from the named site's own versions", () => {
  it("a site-restricted key cannot read another site's version through its own site", async () => {
    const dw = await freshInstance();
    const versions = await publishSecret(dw);
    const k = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "one-only", scopes: ["sites:read"], site: "site-one" }) });
    expect(k.status).toBe(201);
    const own = await dw.call(`/api/v1/sites/site-one/files/secret.txt?version=${versions.one}`, { key: k.body.key });
    expect(own.status, "positive control").toBe(200);
    expect(await own.text()).toBe("site-one bytes");

    const cross = await dw.json(`/api/v1/sites/site-one/files/secret.txt?version=${versions.two}`, { key: k.body.key });
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe("file_not_found");
    expect(JSON.stringify(cross.body)).not.toContain(SECRET);
  });

  it("a pending version cannot read bytes its owner never uploaded", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    await publishSecret(dw);
    const { bytes, ...entry } = await manifestEntry("stolen.txt", SECRET);
    expect(bytes.length).toBeGreaterThan(0);
    const anon = await dw.json("/api/v1/publish", jsonBody({ files: [entry] }));
    expect(anon.status, JSON.stringify(anon.body)).toBe(202);
    expect(anon.body.upload.items).toHaveLength(1);
    const claim = anon.body.claim.token as string;
    const read = await dw.json(`/api/v1/sites/${anon.body.site.slug}/files/stolen.txt?version=${anon.body.version.id}`, { key: claim });
    expect(read.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toContain(SECRET);
  });
});
