import { escapeHtml } from "../html";
import { createQrEncoder } from "../qr.js";
import type { ViewerContext } from "./index";

const qrcode = createQrEncoder();
const MAX_SVG_LENGTH = 128 * 1024;
// Byte-mode capacity at version 40 / H. Refuse before allocating encoder buffers.
const MAX_QR_BYTES = 1273;

/** A bounded, deterministic image, with a four-module white quiet zone. */
function phoneSvg(url: string): string {
  if (new TextEncoder().encode(url).length > MAX_QR_BYTES) return "";
  try {
    // H tolerates damage/glare during a screen-to-camera handoff. The dashboard
    // keeps its existing M setting and pixel output, using the very same core.
    const qr = qrcode(0, "H");
    qr.addData(url);
    qr.make();
    const count = qr.getModuleCount();
    const size = count + 8;
    const runs: string[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (!qr.isDark(row, col)) continue;
        const start = col;
        while (col + 1 < count && qr.isDark(row, col + 1)) col++;
        runs.push(`M${start + 4} ${row + 4}h${col - start + 1}v1H${start + 4}z`);
      }
    }
    // Display at whole CSS pixels per module (never a fractional scale,
    // which aliases modules to unequal widths at devicePixelRatio 1):
    // the largest whole multiple of the module grid up to 256px. The
    // inline width keeps that alignment when the panel or a short
    // viewport is the tighter bound. Never shrink below one pixel per
    // module: the open bar is non-sticky and the panel does not clip,
    // so native document scrolling can expose larger grids in full.
    // Browsers without round() use the aligned width attribute.
    const px = size * Math.max(1, Math.floor(256 / size));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${px}" height="${px}" style="width:max(${size}px,round(down,min(${px}px,100%,calc(100dvh - 10rem - 2px)),${size}px));height:auto" role="img" aria-label="Scan to open this file on your phone" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${runs.join("")}" fill="#000"/></svg>`;
    return svg.length <= MAX_SVG_LENGTH ? svg : "";
  } catch {
    // A failed/over-capacity QR must never prevent opening the file or link.
    return "";
  }
}

/** Only live public file addresses: never a preview address or a request's grants. */
export function viewerPhone(vc: ViewerContext): string {
  if (vc.embed || vc.preview) return "";
  const url = vc.url.origin + vc.fileUrl;
  const link = escapeHtml(url);
  const svg = phoneSvg(url);
  return `<details class="dw-phone"><summary>Phone</summary><div class="dw-phone-panel"><p>Open this file on your phone</p>${svg || '<p class="dw-muted">This URL is too long for a QR code. Use the link instead.</p>'}<a href="${link}" rel="nofollow">${link}</a></div></details>`;
}
