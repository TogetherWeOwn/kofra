// Types for the screenshot-harness helpers exported as "@dropway/server/e2e-design".
import type { Browser, BrowserContext, BrowserContextOptions, Page, Request } from "playwright-core";
export interface Gate {
  pass: boolean;
  detail?: unknown;
}
export const SETTLE: () => Promise<void>;
export function filmstrip(
  browser: Browser,
  opts: {
    targets: Array<{ id: string; url: (mode: "light" | "dark") => string; [key: string]: unknown }>;
    respond: (request: Request) => Promise<{ status: number; headers: Record<string, string>; body: Buffer } | null>;
    prepare?: (context: BrowserContext, mode: "light" | "dark", target: { id: string; [key: string]: unknown }) => Promise<void>;
    contextOptions?: BrowserContextOptions;
    modes?: Array<"light" | "dark">;
  },
): Promise<Record<string, Gate>>;
export function dominantColours(browser: Browser, frames: string[]): Promise<Array<[number, number, number]>>;
export const TEXT_SPACING_CSS: string;
export interface ClippedText {
  id: string;
  el: string;
  text: string;
  x: string | null;
  y: string | null;
}
export const CLIPPED_TEXT: () => ClippedText[];
export function textSpacingLoss(page: Page): Promise<ClippedText[]>;
