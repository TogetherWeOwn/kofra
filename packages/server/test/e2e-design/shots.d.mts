// Types for the parts of the screenshot harness that unit tests import (the rest runs only as a script).
export interface Gate {
  pass: boolean;
  detail?: unknown;
}
export interface Cell {
  gates: Record<string, Gate>;
  [key: string]: unknown;
}
export interface Checks {
  themeSwitch?: Record<string, Gate>;
  filmstrip?: Record<string, Gate>;
}
export function failures(matrix: Cell[], checks?: Checks): { failed: Cell[]; switchFailed: string[] };
export function exitCodeFor(matrix: Cell[], checks?: Checks): 0 | 1;
export function checkSelection(only?: Set<string> | null, widths?: number[], modes?: string[]): void;
export function startFreshWorker<T extends object>(start: (dir: string) => Promise<T>): Promise<T & { dir: string }>;
export function unexpectedFailures(failed: string[], screen: { url: string; status?: number; expectFailed?: string[] }): string[];
/** The core Worker in Miniflare at https://kofra.test (sites on <slug>.kofra-sites.test), migrated, not set up. */
export function startWorker(tmp: string, bindings?: Record<string, string>): Promise<{ mf: import("miniflare").Miniflare; db: unknown }>;
