/** Composite action adapter. The CLI owns publishing; this file only coordinates PRs. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

class PreviewError extends Error {}
const fail = (message) => { throw new PreviewError(message); };

function httpUrl(value, { secure = false } = {}) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || /\s/.test(value)) {
    fail("Use an HTTP(S) URL without credentials or whitespace.");
  }
  if (secure && url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    fail("Use HTTPS for the Kofra instance (plain HTTP is allowed only for loopback).");
  }
  return url;
}

async function preview() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    console.log("Kofra preview skipped: only pull_request events are supported.");
    return;
  }
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const repository = process.env.GITHUB_REPOSITORY;
  const pr = event.pull_request;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      event.repository?.full_name !== repository || pr?.base?.repo?.full_name !== repository ||
      pr?.head?.repo?.full_name !== repository ||
      !Number.isSafeInteger(event.number) || event.number < 1 || pr.number !== event.number ||
      !["opened", "synchronize", "reopened", "closed"].includes(event.action)) {
    console.log("Kofra preview skipped: untrusted or unsupported PR context.");
    return;
  }

  const token = process.env.KOFRA_ACTION_TOKEN;
  const githubToken = process.env.KOFRA_ACTION_GITHUB_TOKEN;
  const apiInput = process.env.KOFRA_ACTION_API;
  if (!token?.trim() || !githubToken?.trim() || !apiInput?.trim()) {
    fail("Set api, token and github-token before running a preview (no anonymous fallback).");
  }
  // Run this revision's dependency-free CLI source, not a registry package or PR code.
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18) || !process.features.typescript) {
    fail("The Kofra action requires Node 22.18+ with native TypeScript support; use actions/setup-node.");
  }
  const api = httpUrl(apiInput, { secure: true });
  if (api.pathname !== "/" || api.search || api.hash) fail("api must be the Kofra instance origin.");
  const githubApi = httpUrl(process.env.GITHUB_API_URL ?? "https://api.github.com");
  if (githubApi.search || githubApi.hash) fail("Invalid GitHub API URL.");
  const namespace = createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 20);
  const slug = `pr-${namespace}-${event.number}`;
  const marker = `<!-- dropway-preview:${slug} -->`;
  const commentsPath = `/repos/${repository}/issues/${event.number}/comments`;

  async function github(method, path, body) {
    const response = await fetch(`${githubApi.href.replace(/\/$/, "")}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // Never echo remote response bodies: even an error can contain a credential.
    if (!response.ok) fail(`GitHub comment request failed (HTTP ${response.status}). Check pull-requests: write permission.`);
    return response.json();
  }

  async function findComment() {
    for (let page = 1; page <= 100; page++) {
      const comments = await github("GET", `${commentsPath}?per_page=100&page=${page}`);
      if (!Array.isArray(comments)) fail("GitHub returned an invalid comment list.");
      // The marker is public text: bind it to the supported bot identity so a
      // copied marker from another bot (or a human) can never be edited here.
      const found = comments.find((comment) => comment.user?.type === "Bot" &&
        comment.user?.login === "github-actions[bot]" &&
        typeof comment.body === "string" && comment.body.startsWith(marker) &&
        Number.isSafeInteger(comment.id) && comment.id > 0);
      if (found) return found.id;
      if (comments.length < 100) return null;
    }
    fail("Comment search exceeded 10,000 comments; no duplicate comment was created.");
  }

  // The publisher follows file symlinks, so a link could upload bytes from
  // outside the workspace. Previews refuse them outright: directory and broken
  // links stay allowed because the publisher already skips them.
  async function rejectFileSymlinks(root) {
    const pending = [""];
    while (pending.length) {
      const relDir = pending.pop();
      const dirents = await readdir(join(root, relDir), { withFileTypes: true });
      for (const d of dirents) {
        const rel = relDir ? `${relDir}/${d.name}` : d.name;
        if (d.isSymbolicLink()) {
          const target = await stat(join(root, rel)).catch(() => null);
          if (target?.isFile()) {
            fail(`folder contains a symlinked file (${rel}); replace it with a copy or remove it. Previews never publish symlinks.`);
          }
          continue;
        }
        if (d.isDirectory()) pending.push(rel);
      }
    }
  }

  let folder;
  if (event.action !== "closed") {
    if (!process.env.KOFRA_ACTION_FOLDER?.trim()) fail("Set folder to a built directory within the workspace.");
    const workspace = await realpath(process.env.GITHUB_WORKSPACE);
    folder = await realpath(resolve(workspace, process.env.KOFRA_ACTION_FOLDER));
    const path = relative(workspace, folder);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`) || !(await stat(folder)).isDirectory()) {
      fail("folder must be a directory within the caller workspace.");
    }
    await rejectFileSymlinks(folder);
  }

  // Keep caller dropway.json, saved credentials and other CI credentials out of the CLI.
  const temp = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "kofra-preview-"));
  async function cli(args) {
    try {
      const result = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url)),
        ...args, "--api", api.origin, "--json",
      ], {
        cwd: temp, timeout: 10 * 60_000, maxBuffer: 1024 * 1024,
        env: { HOME: temp, KOFRA_CONFIG_DIR: join(temp, "config"), KOFRA_API_KEY: token },
      });
      return { code: 0, data: JSON.parse(result.stdout) };
    } catch (error) {
      // stdout/stderr may contain tokens, content, or terminal workflow commands.
      // Keep only the stable snake_case error code; never print the bodies.
      if (Number.isInteger(error.code)) {
        let errorCode;
        try {
          const parsed = JSON.parse(error.stdout ?? "");
          if (parsed?.ok === false && typeof parsed.error?.code === "string") errorCode = parsed.error.code;
        } catch {
          // Non-JSON failure output carries no verified code; callers fail closed.
        }
        return { code: error.code, errorCode };
      }
      fail("Kofra CLI could not complete. Check the instance, folder and runtime.");
    }
  }

  try {
    if (event.action === "closed") {
      // A bare "not found" exit is not proof of absence: a key without
      // sites:read, a wrong instance, or a proxy 404 all exit 4 while the
      // preview stays public. Verify the key first, then only tolerate a
      // verified Kofra site_not_found, and confirm successful deletions.
      const identity = await cli(["whoami"]);
      if (identity.code !== 0) fail(`Kofra cleanup failed: the preview key was rejected (CLI exit ${identity.code}). Check the key and instance.`);
      const scopes = identity.data?.scopes;
      if (identity.data?.principal !== "member" || !Array.isArray(scopes) ||
          !scopes.includes("sites:read") || !scopes.includes("sites:write") ||
          identity.data?.siteRestriction) {
        fail("Kofra cleanup failed: the preview key needs unrestricted sites:read and sites:write. Check the key and instance.");
      }
      const result = await cli(["delete", slug, "--yes"]);
      if (result.code === 4 && result.errorCode === "site_not_found") {
        console.log("Kofra preview removed (or already absent).");
        return;
      }
      if (result.code !== 0) fail(`Kofra cleanup failed (CLI exit ${result.code}); only a verified missing site is ignored.`);
      if (result.data?.deleted !== true || result.data?.slug !== slug) {
        fail("Kofra cleanup failed: the instance did not confirm deletion. Check the instance.");
      }
      console.log("Kofra preview removed (or already absent).");
      return;
    }

    // Read comments first: missing GitHub permission must not leave a new preview.
    const commentId = await findComment();
    const result = await cli(["publish", folder, "--site", slug, "--no-save"]);
    if (result.code !== 0) fail(`Kofra publish failed (CLI exit ${result.code}). Check the key, instance and build output.`);
    const url = httpUrl(result.data.url);
    if (result.data.slug !== slug || url.search || url.hash ||
        [token, githubToken].some((secret) => result.data.url.includes(secret))) {
      fail("Kofra returned an invalid preview result; no URL was exposed.");
    }
    const body = `${marker}\n**Kofra preview:** <${url.href}>`;
    await github(commentId ? "PATCH" : "POST", commentId ? `/repos/${repository}/issues/comments/${commentId}` : commentsPath, { body });
    await appendFile(process.env.GITHUB_OUTPUT, `url=${url.href}\nslug=${slug}\n`);
    console.log("Kofra preview published and PR comment updated.");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

try {
  await preview();
} catch (error) {
  // Only messages authored above are safe to print; never stringify arbitrary errors.
  console.error(error instanceof PreviewError ? error.message : "Kofra preview failed. Check the event, inputs, network and Node runtime.");
  process.exitCode = 1;
}
