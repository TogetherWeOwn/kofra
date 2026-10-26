/** Matrix-only interface of the vendored, closure-free QR factory in qr.js. */
export interface QrMatrix {
  addData(text: string): void;
  make(): void;
  isDark(row: number, col: number): boolean;
  getModuleCount(): number;
}

export function createQrEncoder(): (version: number, correction: "L" | "M" | "Q" | "H") => QrMatrix;
