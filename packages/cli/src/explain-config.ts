/** Offline diagnostics only. Never use file-health classification to tighten the resolver. */
import { readFile } from "node:fs/promises";
import { configDir, credentialsPath, linkKey, linkPath } from "./config.ts";
import { isLoopbackHostname, normaliseApi } from "./client.ts";
import { withLegacyEnv } from "./legacy-brand.ts";

interface Source {
  kind: "flag" | "env" | "project" | "default" | "saved";
  detail: string | null;
  viaLegacyName?: boolean;
}
interface Health {
  state: "absent" | "valid" | "malformed" | "unreadable";
  detail: "invalid_json" | "invalid_shape" | "permission" | "not_a_file" | "io_error" | null;
}
interface JsonFile extends Health { value: unknown }
interface KeyReport {
  present: boolean;
  source: Source | null;
  kind: "api_key" | "claim_token" | "other" | null;
}
interface Check {
  id: string;
  severity: "info" | "warning" | "error";
  code: string;
  hint: string;
  nextAction: string | null;
  source?: Source;
  detail?: Health["detail"];
  removed?: string[];
}
export interface ConfigExplanation {
  schema: "kofra.explain-config/v1";
  ok: boolean;
  status: "ready" | "needs_key" | "unconfigured";
  exitCode: 0 | 2 | 3;
  api: { origin: string | null; source: Source | null };
  key: KeyReport;
  configDir: { selector: string; viaLegacyName: boolean; path: string | null };
  credentialsFile: Health & { defaultPresent: boolean | null; instanceCount: number | null; hasEntryForEffectiveApi: boolean | null };
  projectLink: Health & { apiMatchesEffective: boolean | null; sitesEntryCount: number | null; mapping: { key: string; slug: string | null } | null };
  checks: Check[];
}

const source = (kind: Source["kind"], detail: string | null = null): Source => ({ kind, detail });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Legacy readers accept arrays as objects and leave entry fields unpoliced.
const looseObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

async function readJson(path: string): Promise<JsonFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "absent", detail: null, value: null };
    const detail = code === "EACCES" || code === "EPERM" ? "permission"
      : code === "EISDIR" || code === "ENOTDIR" ? "not_a_file" : "io_error";
    return { state: "unreadable", detail, value: null };
  }
  try {
    return { state: "valid", detail: null, value: JSON.parse(text) as unknown };
  } catch {
    return { state: "malformed", detail: "invalid_json", value: null };
  }
}

function credentialsShape(v: unknown): boolean {
  return object(v)
    && (!("default" in v) || v.default === null || typeof v.default === "string")
    && (!("instances" in v) || (object(v.instances) && Object.values(v.instances).every(object)));
}
function linkShape(v: unknown): boolean {
  return object(v)
    && (!("api" in v) || typeof v.api === "string")
    && (!("sites" in v) || (object(v.sites) && Object.values(v.sites).every((slug) => typeof slug === "string")));
}
function health(file: JsonFile, shape: (v: unknown) => boolean): Health {
  return file.state === "valid" && !shape(file.value)
    ? { state: "malformed", detail: "invalid_shape" } : { state: file.state, detail: file.detail };
}

/** Source names must be taken from raw env, before withLegacyEnv fills twins. */
function envSource(env: NodeJS.ProcessEnv, suffix: string): Source | null {
  const name = env[`KOFRA_${suffix}`] ? `KOFRA_${suffix}` : env[`DROPWAY_${suffix}`] ? `DROPWAY_${suffix}` : null;
  return name ? { kind: "env", detail: name, viaLegacyName: name.startsWith("DROPWAY_") } : null; // rebrand:keep
}
function describeKey(value: unknown, selected: Source): KeyReport {
  if (!value) return { present: false, source: null, kind: null };
  return {
    present: true, source: selected,
    kind: typeof value === "string" && value.startsWith("dw_") ? "api_key"
      : typeof value === "string" && value.startsWith("dwc_") ? "claim_token" : "other",
  };
}

function removedParts(raw: string): string[] {
  // Match normaliseApi's scheme inference, including the loopback exception:
  // canonicalise through the URL parser so IPv4 shorthands count as loopback.
  let input = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    let host = input.split("/")[0]!;
    try {
      host = new URL(`http://${host}`).hostname;
    } catch {
      // Keep the raw host; the parse below reports the invalid input.
    }
    input = `${isLoopbackHostname(host) ? "http" : "https"}://${input}`;
  }
  const url = new URL(input);
  return [
    ...(url.username || url.password ? ["userinfo"] : []),
    ...(url.pathname && url.pathname !== "/" ? ["path"] : []),
    ...(url.search || input.includes("?") && input.indexOf("?") < (input.indexOf("#") < 0 ? input.length : input.indexOf("#")) ? ["query"] : []),
    ...(input.includes("#") ? ["fragment"] : []),
  ];
}

const MARKER = "[…truncated]";
function bounded(value: string): string {
  return value.length > 1024 ? `${value.slice(0, 1024 - MARKER.length)}${MARKER}` : value;
}

interface ExplainInput { api?: string; key?: string; path?: string; env: NodeJS.ProcessEnv; cwd: string }

/** Raw credentials and saved-key references never escape this scope. */
async function inspectResolution(input: ExplainInput, link: Record<string, unknown> | null) {
  const { env } = input;
  const credentials = await readJson(credentialsPath(withLegacyEnv(env)));
  const credentialsHealth = health(credentials, credentialsShape);
  const creds = looseObject(credentials.value) ? credentials.value : null;

  // Same nullish/truthy chain as resolveInstance; invalid_shape is NOT a veto.
  const candidates: Array<{ raw: unknown; source: Source }> = [];
  if (input.api !== undefined) candidates.push({ raw: input.api, source: source("flag", "--api") });
  for (const suffix of ["API", "URL"]) {
    const selected = envSource(env, suffix);
    if (selected) candidates.push({ raw: env[selected.detail!], source: selected });
  }
  if (link?.api !== undefined && link.api !== null) candidates.push({ raw: link.api, source: source("project") });
  if (typeof creds?.default === "string") candidates.push({ raw: creds.default, source: source("default") });
  const winner = candidates[0];
  let origin: string | null = null;
  let removed: string[] = [];
  let invalid = false;
  if (winner?.raw) {
    try {
      origin = normaliseApi(winner.raw as string);
      removed = removedParts(winner.raw as string);
    } catch {
      invalid = true;
    }
  }

  const instances = looseObject(creds?.instances) ? creds.instances : {};
  // Reduce credentials to booleans/counts/kind immediately; no saved key is
  // copied into a report, check, closure, hint or human formatter.
  const savedKey = origin ? (instances[origin] as { key?: unknown } | null | undefined)?.key : undefined;
  const keyEnv = envSource(env, "API_KEY");
  const key = !origin ? describeKey(null, source("saved"))
    : input.key ? describeKey(input.key, source("flag", "--key"))
      : keyEnv ? describeKey(env[keyEnv.detail!], keyEnv)
        : describeKey(savedKey, source("saved"));
  const credentialsFile: ConfigExplanation["credentialsFile"] = {
    ...credentialsHealth,
    defaultPresent: credentialsHealth.state === "absent" ? false : credentialsHealth.state === "valid" ? typeof creds?.default === "string" : null,
    instanceCount: credentialsHealth.state === "absent" ? 0 : credentialsHealth.state === "valid" ? Object.keys(instances).length : null,
    hasEntryForEffectiveApi: credentialsHealth.state === "absent" ? (origin ? false : null) : credentialsHealth.state === "valid" && origin ? !!savedKey : null,
  };
  return {
    origin, removed, invalid, key, credentialsFile,
    selectedSource: winner?.source ?? null, emptyApi: !!winner && !winner.raw,
    shadowedSources: candidates.slice(1).map((candidate) => candidate.source),
  };
}

export async function explainConfig(input: ExplainInput): Promise<ConfigExplanation> {
  const { env, cwd } = input;
  const linkFile = await readJson(linkPath(cwd));
  const linkHealth = health(linkFile, linkShape);
  const link = looseObject(linkFile.value) ? linkFile.value : null;
  const { origin, removed, invalid, key, credentialsFile, selectedSource, emptyApi, shadowedSources } = await inspectResolution(input, link);
  const credentialsHealth = credentialsFile;
  const linkAvailable = linkHealth.state === "valid" || linkHealth.state === "absent";
  const matches = !!origin && link?.api === origin;
  const sites = object(link?.sites) ? link.sites : {};
  const lookupKey = input.path === undefined ? null : linkKey(cwd, input.path);
  const slug = lookupKey !== null && linkHealth.state === "valid" && matches && typeof sites[lookupKey] === "string" && sites[lookupKey] ? sites[lookupKey] as string : null;
  const projectLink: ConfigExplanation["projectLink"] = {
    ...linkHealth,
    apiMatchesEffective: linkAvailable ? matches : null,
    sitesEntryCount: linkAvailable ? Object.keys(sites).length : null,
    mapping: lookupKey === null ? null : { key: bounded(lookupKey), slug: slug === null ? null : bounded(slug) },
  };
  // Check a foreign link only after health, without diagnosing shadowed API values.
  let foreignLink = false;
  if (origin && linkHealth.state === "valid" && typeof link?.api === "string" && !matches && link.api) {
    try { normaliseApi(link.api); foreignLink = true; } catch { /* Not a valid foreign instance. */ }
  }
  linkFile.value = null;

  const checks: Check[] = [];
  const add = (id: string, severity: Check["severity"], code: string, hint: string, nextAction: string | null = null, extra: Partial<Check> = {}) => {
    checks.push({ id, severity, code, hint, nextAction, ...extra });
  };
  if (selectedSource) add("api.selected", "info", "source_selected", "The first present API source wins.", null, { source: selectedSource });
  else add("api.unconfigured", "error", "no_instance", "No instance source is configured.", "kofra login --api https://<your-instance>");
  if (emptyApi) add("api.empty_value", "error", "empty_value", "The winning API source is empty; lower sources remain shadowed.", "Unset the empty source or pass --api https://<your-instance>.");
  if (invalid) add("api.invalid_value", "error", "invalid_api_url", "The winning API source is not an HTTP(S) origin.", "Pass --api https://<your-instance>.");
  if (removed.length) add("api.value_trimmed", "info", "input_trimmed", "URL parts were removed. If userinfo contained credentials, rotate them and clean up shell history and env.", "Use the bare origin https://<host>.", { removed });
  for (const shadowed of shadowedSources) add("api.source_shadowed", "info", "source_shadowed", "A lower API source is set but was not consulted.", null, { source: shadowed });
  if (key.present) add("key.selected", "info", "source_selected", "A key source is present; authorization was not checked.", null, { source: key.source! });
  if (origin && !key.present) add("key.absent", "error", "not_logged_in", "No key is configured. Callers using --anonymous may treat exit 3 as OK; never auto-login on exit 3.", "kofra login --api <effective-origin>");
  if (key.present && key.kind !== "api_key") add("key.kind_noted", "info", "key_kind", "Key kind is derived from its prefix only, not validated.");
  if (credentialsHealth.state === "malformed") add("credentials_file.malformed", "error", "malformed_credentials", "Credentials file is malformed; effective resolution remains permissive.", "kofra login --api https://<your-instance>", { detail: credentialsHealth.detail });
  if (credentialsHealth.state === "unreadable") add("credentials_file.unreadable", "error", "unreadable_credentials", "Credentials file could not be read.", "Check the permissions of <path>.", { detail: credentialsHealth.detail });
  if (linkHealth.state === "malformed") add("project_link.malformed", "error", "malformed_project_link", "Project link is malformed; diagnostic mappings are unavailable.", "Delete or fix ./dropway.json.", { detail: linkHealth.detail });
  if (linkHealth.state === "unreadable") add("project_link.unreadable", "error", "unreadable_project_link", "Project link could not be read.", "Check the permissions of ./dropway.json.", { detail: linkHealth.detail });
  if (foreignLink) add("project_link.foreign_instance", "warning", "foreign_project_link", "Project link does not exactly match the effective origin; mappings are ignored.", "Publish once with --api <effective-origin> --new, or remove ./dropway.json.");
  if (lookupKey !== null) add(slug === null ? "project_link.mapping_missing" : "project_link.mapping_found", "info", slug === null ? "mapping_missing" : "mapping_found", slug === null ? "No applicable mapping was found for the requested path." : "An applicable mapping was found for the requested path.");
  for (const suffix of ["API", "URL", "API_KEY"]) {
    if (env[`KOFRA_${suffix}`] && env[`DROPWAY_${suffix}`]) add("env.legacy_shadowed", "info", "source_shadowed", "A modern environment name shadows its legacy twin.", null, { source: { kind: "env", detail: `DROPWAY_${suffix}`, viaLegacyName: true } }); // rebrand:keep
  }

  const dirSource = envSource(env, "CONFIG_DIR");
  const selector = dirSource?.detail ?? (env.XDG_CONFIG_HOME ? "XDG_CONFIG_HOME" : process.platform === "win32" && env.APPDATA ? "APPDATA" : "default");
  const defaultPath = selector === "default" && configDir(withLegacyEnv(env)) === configDir({}) ? "~/.config/dropway" : null;
  const exitCode = !origin ? 2 : key.present ? 0 : 3;
  return {
    schema: "kofra.explain-config/v1", ok: exitCode === 0,
    status: exitCode === 0 ? "ready" : exitCode === 3 ? "needs_key" : "unconfigured", exitCode,
    api: { origin: origin === null ? null : bounded(origin), source: selectedSource }, key,
    configDir: { selector, viaLegacyName: dirSource?.viaLegacyName ?? false, path: defaultPath },
    credentialsFile, projectLink, checks: checks.slice(0, 32),
  };
}

function terminalText(value: string): string {
  return bounded(value.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

export function explainConfigHuman(report: ConfigExplanation): string {
  const lines = [
    `Status: ${report.status} (exit ${report.exitCode})`,
    `Instance: ${report.api.origin ?? "unconfigured"} (from ${report.api.source?.detail ?? report.api.source?.kind ?? "none"})`,
    `Key: ${report.key.source?.detail ?? report.key.source?.kind ?? "absent"} ${report.key.kind ?? "none"}`,
    `Config directory: ${report.configDir.path ?? report.configDir.selector}`,
    `Credentials: ${report.credentialsFile.state}${report.credentialsFile.detail ? ` (${report.credentialsFile.detail})` : ""}; default present: ${report.credentialsFile.defaultPresent ?? "unavailable"}; instances: ${report.credentialsFile.instanceCount ?? "unavailable"}; saved key for origin: ${report.credentialsFile.hasEntryForEffectiveApi ?? "unavailable"}`,
    `Project link: ${report.projectLink.state}${report.projectLink.detail ? ` (${report.projectLink.detail})` : ""}; API matches: ${report.projectLink.apiMatchesEffective ?? "unavailable"}; mappings: ${report.projectLink.sitesEntryCount ?? "unavailable"}`,
  ];
  for (const check of report.checks) {
    lines.push(`${check.code}${check.source ? ` (${check.source.detail ?? check.source.kind})` : ""}: ${check.hint}${check.nextAction ? ` ${check.nextAction}` : ""}`);
  }
  if (report.projectLink.mapping) lines.push(`Mapping: ${terminalText(report.projectLink.mapping.key)} -> ${report.projectLink.mapping.slug === null ? "missing" : terminalText(report.projectLink.mapping.slug)}`);
  return lines.join("\n");
}
