/** Protected, implementation-independent history fixture shared by VM and Chromium. */
export const slug = "loaded-version-history";
export const base = `/api/v1/sites/${slug}`;
export const markup = '<img src=x onerror="window.__historyMarkupExecuted=true">';
export const id = (number: number) => `history-release-${number}`;
export const artifact = (number: number) => `artifact-${number}.txt`;
export function version(number: number) {
  return {
    id: id(number), number, live: number === 105, status: "ready",
    fileCount: 1, totalBytes: 7,
    message: number === 103 ? "release [blue].* + (safe)" : number === 87 ? markup :
      [104, 102].includes(number) ? "Needle deployment" : number === 41 ? null :
        number === 1 ? "old linked release" : "ordinary deployment",
    client: number === 42 ? "Desktop/2.7" : number === 41 ? null : "fixture-client",
    source: number === 64 ? "mcp" : "api",
    createdAt: "2026-10-22T12:00:00.000Z", finalizedAt: "2026-10-22T12:00:01.000Z",
  };
}
export const allVersions = Array.from({ length: 105 }, (_, index) => version(105 - index));
export const loadedNumbers = Array.from({ length: 100 }, (_, index) => 105 - index);
export function manifest(number: number) {
  const path = artifact(number);
  return { version: version(number), files: [{ path, size: 7,
    sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
    contentType: "text/plain", kind: "text", extension: "txt",
    url: `https://files.example.test/${slug}/${path}`, rawUrl: `${base}/files/${path}`,
  }], total: 1, nextCursor: null };
}
