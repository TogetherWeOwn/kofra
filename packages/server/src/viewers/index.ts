import { detectFileKind, type DropwayContext, type FileKind, type LiveSite } from "@dropway/core";
import { archiveViewer } from "./archive";
import { binaryViewer } from "./binary";
import { codeViewer, sourceViewer } from "./code";
import { csvViewer } from "./csv";
import { htmlFrameViewer } from "./html-frame";
import { jsonViewer } from "./json";
import { markdownViewer } from "./markdown";
import { audioViewer, fontViewer, imageViewer, pdfViewer, svgViewer, videoViewer } from "./media";
import { notebookViewer } from "./notebook";

/**
 * Viewers turn a stored file into a rendered page when a person opens it in a
 * browser. They never run for sub-resource requests (fetch, <img>, <script>):
 * those always get the raw bytes, so sites keep working. `?raw=1` always
 * returns the raw bytes; `?view=1` forces the viewer; `?view=source` shows the
 * highlighted source of any text file (HTML included); `&embed=1` drops the
 * viewer bar (the app-origin viewer page frames views and has its own toolbar).
 *
 * To add a viewer: create a file in this folder exporting a Viewer, then add it
 * to VIEWERS below (or pass it in createDropway({ viewers }), which runs before
 * these). Match on file.kind (from @dropway/core detectFileKind) and the view
 * mode. The first match wins. Wrap output with viewerPage() from ./chrome so
 * every viewer shares the same bar.
 */
export interface ViewerFile {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
  kind: FileKind;
}

/**
 * Why a viewer is being asked:
 * - document: a top-level browser navigation to the file
 * - frame:    the file is loaded in an <iframe> (a site embedding its own PDF or video should get raw bytes)
 * - view:     ?view=1 (always a viewer page when one exists, HTML included)
 * - source:   ?view=source (highlighted source of a text file)
 */
export type ViewMode = "document" | "frame" | "view" | "source";

export interface ViewerContext {
  dw: DropwayContext;
  request: Request;
  url: URL;
  live: LiveSite;
  file: ViewerFile;
  mode: ViewMode;
  /** Render without the viewer bar (set by &embed=1). */
  embed: boolean;
  /** URL path of the file on this origin, no query: navigations get the default view, sub-resources the bytes. */
  fileUrl: string;
  /** Same path + ?view=1. */
  viewUrl: string;
  /** Same path + ?view=source. */
  sourceUrl: string;
  /** URL of the raw bytes (same path + ?raw=1; text types come back as text/plain). */
  rawUrl: string;
  /** URL that downloads the file (same path + ?download=1). */
  downloadUrl: string;
  /** URL path of the site root on this origin (ends in "/"). */
  siteBase: string;
  /** Absolute URL of the app-origin viewer page for this file (file tree, tabs). */
  appViewerUrl: string;
  /** Read the whole file as UTF-8 text (only call when file.size is reasonable for the viewer). */
  readText(): Promise<string>;
  /** Read `length` bytes from `offset` (defaults: the whole file). */
  readBytes(offset?: number, length?: number): Promise<Uint8Array>;
}

export interface Viewer {
  id: string;
  /** Bump when the output changes: it is part of the ETag and of the render cache key. Default 1. */
  version?: number;
  /**
   * Extra render identity beyond the file's own bytes (e.g. neighbours the
   * page links to), appended to the ETag so a conditional request cannot
   * revalidate a page whose surroundings changed. Must be cheap and
   * synchronous: it runs before rendering, on every request.
   */
  etagExtra?(file: ViewerFile, live: LiveSite): string;
  /** Files larger than this are served raw instead. */
  maxBytes: number;
  /** `mode` is undefined for viewers written before view modes existed; treat it as "document". */
  matches(file: ViewerFile, live: LiveSite, mode?: ViewMode): boolean;
  /** Return the full response (an HTML page). Headers such as CSP are added by the caller if absent. */
  render(vc: ViewerContext): Promise<Response>;
}

/** Core viewers in match order: source first, then specific kinds, then the code/text and binary fallbacks. */
export const VIEWERS: Viewer[] = [
  sourceViewer,
  htmlFrameViewer,
  markdownViewer,
  notebookViewer,
  jsonViewer,
  csvViewer,
  svgViewer,
  imageViewer,
  pdfViewer,
  videoViewer,
  audioViewer,
  fontViewer,
  archiveViewer,
  codeViewer,
  binaryViewer,
];

export function toViewerFile(path: string, sha256: string, size: number, contentType: string): ViewerFile {
  return { path, sha256, size, contentType, kind: detectFileKind(path, contentType) };
}

export function findViewer(file: ViewerFile, live: LiveSite, viewers: readonly Viewer[] = VIEWERS, mode: ViewMode = "document"): Viewer | null {
  for (const v of viewers) if (file.size <= v.maxBytes && v.matches(file, live, mode)) return v;
  return null;
}

export { VIEWER_CSP, viewerCsp } from "./chrome";
