import { zlibSync } from "fflate";

/** Self-created, decodable artwork; shared by workerd and real-browser tests.
 * 1600x1000: the middle rectangle (x=400..1199, y=250..749) is white/black,
 * the border is transparent. The opaque control is solid #606060 everywhere.
 * No downloaded assets, canvas, image decoder or production fixture endpoint.
 */
function png(shade: number, opaque = false, padding = 0): Uint8Array {
  const width = 1600, height = 1000;
  const scanlines = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!opaque && !(x >= 400 && x < 1200 && y >= 250 && y < 750)) continue;
      const offset = y * (1 + width * 4) + 1 + x * 4;
      scanlines.set([shade, shade, shade, 255], offset);
    }
  }
  function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length + 12);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of out.subarray(4, out.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    view.setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0);
    return out;
  }
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlibSync(scanlines, { level: 9 })),
    // A valid unknown ancillary chunk exercises the bounded dimension sniff
    // with a >64 KiB image while remaining decodable by an ordinary img.
    ...(padding ? [chunk("teSt", new Uint8Array(padding))] : []), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const svg = (fill: string, script = "") => new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><rect x="400" y="250" width="800" height="500" fill="${fill}"/>${script}</svg>`,
);

export const imageBackgroundFiles = [
  { path: "light.png", type: "image/png", viewer: "image", shade: 255, bytes: png(255) },
  { path: "dark.png", type: "image/png", viewer: "image", shade: 0, bytes: png(0) },
  { path: "light.svg", type: "image/svg+xml", viewer: "svg", shade: 255, bytes: svg("white", `<script>globalThis.imageBackgroundScriptRan = true; fetch('/svg-script-ran');</script>`) },
  { path: "dark.svg", type: "image/svg+xml", viewer: "svg", shade: 0, bytes: svg("black") },
  { path: "opaque.png", type: "image/png", viewer: "image", shade: 96, bytes: png(96, true, 128 * 1024) },
] as const;
