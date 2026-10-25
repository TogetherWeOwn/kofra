import { badRequest } from "../errors";

/** Preserve successful legacy coercions, but report malformed JSON as a field error. */
export function stringField(value: unknown, path: string): string {
  try {
    return String(value);
  } catch {
    const message = `${path} must be convertible to a string.`;
    throw badRequest("invalid_field", message, "Correct the listed field and retry.", { fields: [{ path, message }] });
  }
}
