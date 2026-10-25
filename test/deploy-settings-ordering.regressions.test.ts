import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, manifestEntry } from "./helpers";

// Review pin (PR #23): POST /deploys parses metadata before writing site
// settings, so a settings change plus malformed message/baseVersionId
// returns 400 invalid_field with the site row untouched.
const poison = { toString: null };
const slug = "ordering-guard";
const siteApi = `/api/v1/sites/${slug}`;

describe("deploy settings/metadata ordering", () => {
  for (const name of ["message", "baseVersionId"] as const) {
    it(`rejects deploy ${name} poison without writing settings`, async () => {
      const instance = await freshInstance();
      const created = await instance.json("/api/v1/sites", {
        key: instance.ownerKey, ...jsonBody({ slug }),
      });
      expect(created.status).toBe(201);
      const { bytes: _bytes, ...entry } = await manifestEntry("index.txt", "hello");
      const before = await env.DB.prepare("SELECT * FROM sites WHERE slug = ?").bind(slug).first();
      const result = await instance.json(`${siteApi}/deploys`, {
        key: instance.ownerKey, ...jsonBody({ files: [entry], title: "pwned-title", [name]: poison }),
      });
      expect(result.status, JSON.stringify(result.body)).toBe(400);
      // The handler parses metadata before writing settings, so the poison
      // fails closed with nothing written.
      expect(result.body.error.code).toBe("invalid_field");
      expect(result.body.error.retryable).toBe(false);
      expect(result.body.error.details.fields.map((field: { path: string }) => field.path)).toContain(name);
      const after = await env.DB.prepare("SELECT * FROM sites WHERE slug = ?").bind(slug).first();
      expect(after, "rejected metadata leaves the site row unchanged").toEqual(before);
      const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>();
      expect(versions?.n, "rejected metadata creates no version").toBe(0);
    });
  }
});
