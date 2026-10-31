import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// R-14's Node script belongs at scripts/measure-freshness.mjs. Keep its tests in
// the existing Node test project, not the workerd project. No remote writes.
// Proposed minimal runner contract (the roadmap doesn't prescribe flags):
// --api <origin> --site <slug> --samples N --interval-ms N --timeout-ms N --json
// DROPWAY_API_KEY supplies the key without exposing it in process arguments. // rebrand:keep
// JSON success exposes p50Ms/p95Ms; errors exit nonzero. The experiment's actual
// workers.dev URL, date, sample count, p50/p95 and cache probe remain manual
// evidence for SELF_HOST.md, never fabricated from this local fixture.
const script = fileURLToPath(new URL("../../../scripts/measure-freshness.mjs", import.meta.url));
const KEY = "dw_freshness_test_only_not_a_real_key";

async function fixture(visible: boolean) {
  let api = "";
  let version = 0;
  let oldBody = "before the measurement";
  let newBody = oldBody;
  let polls = 0;
  const published: string[] = [];
  const completedPolls: number[] = [];
  const errors: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/api/v1/publish") {
        if (req.headers.authorization !== `Bearer ${KEY}`) {
          res.writeHead(401).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        let slug: string;
        let content: string;
        if (req.headers["content-type"]?.includes("application/json")) {
          const json = JSON.parse(body.toString());
          slug = json.slug;
          const file = json.files[0];
          content = file.encoding === "base64" ? Buffer.from(file.content, "base64").toString() : file.content;
        } else {
          const request = new Request(`${api}/api/v1/publish`, {
            method: "POST", headers: { "Content-Type": req.headers["content-type"] ?? "" }, body,
          });
          const form = await request.formData();
          slug = String(form.get("slug"));
          const file = [...form.values()].find((value): value is File => typeof value !== "string");
          if (!file) throw new Error("measurement publish has no file");
          content = await file.text();
        }
        if (slug !== "freshness" || typeof content !== "string" || content === newBody) {
          throw new Error("each sample must change the bytes on the selected site");
        }
        if (version) oldBody = newBody;
        newBody = content;
        published.push(content);
        version++;
        polls = 0;
        res.writeHead(version === 1 ? 201 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "live", slug: "freshness", url: `${api}/s/freshness/`,
          version: { id: `version-${version}`, number: version, live: true },
          files: ["index.txt"], created: version === 1, uploaded: 1, reused: 0,
        }));
      } else if (req.method === "GET" && req.url?.startsWith("/s/freshness/")) {
        // After each publish the first two live reads are stale. A successful
        // publish response alone is NOT evidence that the live URL changed.
        if (version) polls++;
        const fresh = visible && version > 0 && polls >= 3;
        if (fresh && polls === 3) completedPolls.push(polls);
        res.writeHead(200, {
          "Content-Type": "text/plain", "Cache-Control": "no-store",
          "X-Dropway-Version": `version-${fresh ? version : Math.max(0, version - 1)}`, // rebrand:keep
        });
        res.end(fresh ? newBody : oldBody);
      } else {
        errors.push(`unexpected ${req.method} ${req.url}`);
        res.writeHead(404).end();
      }
    } catch (error) {
      errors.push(String(error));
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    api, published, completedPolls, errors,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function measure(api: string, samples: number, timeoutMs = 2_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--api", api, "--site", "freshness", "--samples", String(samples),
      "--interval-ms", "10", "--timeout-ms", String(timeoutMs), "--json"], {
      env: { ...process.env, DROPWAY_API_KEY: KEY }, stdio: ["ignore", "pipe", "pipe"], // rebrand:keep
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("freshness script exceeded the test's 10s safety bound")); }, 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe("R-14 freshness measurement executable", () => {
  // Break caught: reporting publish latency rather than time until live visibility.
  it("publishes distinct changes, polls through stale live responses and reports percentiles", async () => {
    const server = await fixture(true);
    try {
      const ran = await measure(server.api, 2);
      expect(ran.code, ran.stderr).toBe(0);
      expect(server.errors).toEqual([]);
      expect(server.published).toHaveLength(2);
      expect(new Set(server.published).size).toBe(2);
      expect(server.completedPolls).toEqual([3, 3]);
      const result = JSON.parse(ran.stdout);
      expect(result.p50Ms).toBeGreaterThanOrEqual(0);
      expect(result.p95Ms).toBeGreaterThanOrEqual(result.p50Ms);
      expect(`${ran.stdout}${ran.stderr}`).not.toContain(KEY);
    } finally {
      await server.close();
    }
  });

  // Break caught: a script that hangs forever or labels an unseen change success.
  it("fails within its timeout when the live URL never changes", async () => {
    const server = await fixture(false);
    try {
      const ran = await measure(server.api, 1, 100);
      // Establish that a change really was published, not just a startup error.
      expect(server.errors).toEqual([]);
      expect(server.published).toHaveLength(1);
      expect(server.completedPolls).toEqual([]);
      expect(ran.code).not.toBeNull();
      expect(ran.code).not.toBe(0);
      expect(`${ran.stdout}${ran.stderr}`).not.toContain(KEY);
    } finally {
      await server.close();
    }
  });
});
