/**
 * A small argv parser (no dependencies). Flags are declared per command so that
 * `--site foo` is read as a value while `--json` is a boolean, and unknown flags
 * fail loudly instead of being ignored.
 */

export type FlagKind = "boolean" | "string";

export interface FlagSpec {
  kind: FlagKind;
  /** One-letter alias, e.g. "y" for --yes. */
  short?: string;
  /** Refuse repeated flags rather than silently choosing a value. */
  once?: boolean;
}

export type FlagSpecs = Record<string, FlagSpec>;

export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Parse argv against flag specs. Supports --flag value, --flag=value, --no-flag, -y, and `--` to end flags. */
export function parseArgs(argv: string[], specs: FlagSpecs): Parsed {
  const byShort = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) if (spec.short) byShort.set(spec.short, name);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      let name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let value: string | boolean | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
      let spec = Object.hasOwn(specs, name) ? specs[name] : undefined;
      if (!spec && name.startsWith("no-") && specs[name.slice(3)]?.kind === "boolean" && value === undefined) {
        name = name.slice(3);
        spec = specs[name];
        value = false;
      }
      if (!spec) throw new UsageError(`Unknown option --${name}.`);
      if (spec.once && Object.hasOwn(flags, name)) throw new UsageError(`Pass --${name} only once.`);
      if (spec.kind === "boolean") {
        if (typeof value === "string") {
          if (!["true", "false", "1", "0"].includes(value)) throw new UsageError(`--${name} takes no value (or true/false).`);
          value = value === "true" || value === "1";
        }
        flags[name] = value ?? true;
      } else {
        if (value === undefined) {
          const next = argv[i + 1];
          if (next === undefined || (next.startsWith("-") && next !== "-")) throw new UsageError(`--${name} needs a value.`);
          value = next;
          i++;
        }
        flags[name] = value as string;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1 && arg !== "-") {
      // Bundled short booleans (-yq) or one short flag with a value (-m "msg").
      const letters = arg.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const name = byShort.get(letters[j]!);
        if (!name) throw new UsageError(`Unknown option -${letters[j]}.`);
        const spec = specs[name]!;
        if (spec.once && Object.hasOwn(flags, name)) throw new UsageError(`Pass --${name} only once.`);
        if (spec.kind === "boolean") {
          flags[name] = true;
          continue;
        }
        const rest = letters.slice(j + 1);
        if (rest) flags[name] = rest;
        else {
          const next = argv[i + 1];
          if (next === undefined) throw new UsageError(`-${letters[j]} needs a value.`);
          flags[name] = next;
          i++;
        }
        break;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

export const str = (p: Parsed, name: string): string | undefined => {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
};

export const bool = (p: Parsed, name: string): boolean | undefined => {
  const v = p.flags[name];
  return typeof v === "boolean" ? v : undefined;
};

export function int(p: Parsed, name: string, min: number, max: number): number | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`);
  return n;
}
