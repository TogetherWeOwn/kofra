// Internal presentation provenance, deliberately separate from JSON/domain fields.
const receipts = new WeakSet<object>();

export function markReplayReceipt<T extends object>(result: T): T {
  receipts.add(result);
  return result;
}

export function isReplayReceipt(result: unknown): boolean {
  return result !== null && typeof result === "object" && receipts.has(result);
}
