import { expect, vi } from "vitest";
import { databaseBoundary, request } from "./delivery-review-fixtures";
import { form, type Instance } from "./helpers";
import { attributeUrl, type Transfer } from "./transfer-fixtures";

export const WINDOW_MS = 15 * 60_000;
export const SITE_PASSWORD = "1234";

export function freezePasswordClock(): number {
  const start = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start + 5 * 60_000);
  return start;
}

export async function lockedSite(dw: Instance, slug: string): Promise<string> {
  const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "private content" }, { slug }) });
  expect(pub.status).toBe(201);
  const access = await dw.json(`/api/v1/sites/${slug}/access`, {
    method: "PUT", key: dw.ownerKey, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", password: SITE_PASSWORD }),
  });
  expect(access.status).toBe(200);
  return pub.body.url;
}

export function attempt(dw: Instance, url: string, password: string, ip?: string): Promise<Response> {
  return dw.call(new URL("__dropway/password", url).href, {
    method: "POST", headers: ip ? { "CF-Connecting-IP": ip } : {}, body: new URLSearchParams({ password }),
  });
}

export interface PasswordForm {
  action: string;
  fields: URLSearchParams;
  status: number;
  csp: string;
  cookies: string;
}

/** Read the actual action, inputs and cookies for this visitor; proof stays opaque. */
export async function passwordForm(dw: Instance, url: string, ip: string | undefined, headers: HeadersInit = {}): Promise<PasswordForm> {
  const getHeaders = new Headers(headers);
  getHeaders.set("Accept", "text/html");
  if (ip) getHeaders.set("CF-Connecting-IP", ip);
  else getHeaders.delete("CF-Connecting-IP");
  const page = await dw.call(url, { headers: getHeaders });
  expect(page.headers.get("content-type")).toContain("text/html");
  let action: string | null = null;
  const fields = new URLSearchParams();
  const decode = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const html = await new HTMLRewriter().on("form", { element(element) {
    if (element.getAttribute("method")?.toLowerCase() === "post") action = element.getAttribute("action") ?? url;
  } }).on("form input[name]", { element(element) {
    if (element.getAttribute("disabled") === null) fields.set(decode(element.getAttribute("name")!), decode(element.getAttribute("value") ?? ""));
  } }).transform(page).text();
  expect(html).not.toContain("private content");
  expect(action, "locked page must return a password form").not.toBeNull();
  expect(fields.has("password"), "use the password field returned by the page").toBe(true);
  const cookies = page.headers.getSetCookie().map((value) => value.split(";")[0]!).join("; ");
  return { action: attributeUrl(action!, url), fields, status: page.status, csp: page.headers.get("content-security-policy") ?? "", cookies };
}

export function formSubmission(form: PasswordForm, password: string, ip: string, headers: HeadersInit = {}) {
  const fields = new URLSearchParams(form.fields);
  fields.set("password", password);
  const postHeaders = new Headers(headers);
  postHeaders.set("CF-Connecting-IP", ip);
  postHeaders.set("Content-Type", "application/x-www-form-urlencoded");
  if (form.cookies) postHeaders.set("Cookie", [postHeaders.get("Cookie"), form.cookies].filter(Boolean).join("; "));
  return { method: "POST", body: fields, headers: postHeaders };
}

export function postForm(dw: Instance, form: PasswordForm, password: string, ip: string, headers: HeadersInit = {}, db?: D1Database) {
  const init = formSubmission(form, password, ip, headers);
  return db ? request(dw, form.action, init, { DB: db }) : dw.call(form.action, init);
}

export async function transferAttempt(dw: Instance, transfer: Transfer, password: string, ip: string): Promise<Response> {
  const form = await passwordForm(dw, transfer.url, ip);
  return postForm(dw, form, password, ip, { Origin: new URL(transfer.url).origin });
}

/** Delay one real counter write, not its result, with all other D1 work intact. */
export function delayedCounterWrite(ordinal: number) {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  const db = databaseBoundary(async (statements) => {
    const matching = statements.filter((sql) => /\btransfer_unlock_buckets\b/i.test(sql) && /\b(?:INSERT|UPDATE)\b/i.test(sql));
    const first = writes + 1;
    writes += matching.length;
    if (first <= ordinal && ordinal <= writes) {
      arrive();
      await released;
    }
  });
  return { db, arrived, release };
}
