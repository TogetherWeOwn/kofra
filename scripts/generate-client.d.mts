/** Types for ./generate-client.mjs (imported by packages/client/test/generate.test.ts). */
export function toMethodName(id: string): string;
export function toTypeName(id: string): string;
export function jsonSchemaToTs(schema: unknown, indent?: string): string;
export function emitInterface(name: string, schema: unknown): string;
export interface GeneratorOperation {
  id: string;
  method: string;
  path: string;
  summary: string;
  rawBody: boolean;
  responseType: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}
export function emitClient(operations: GeneratorOperation[]): string;
