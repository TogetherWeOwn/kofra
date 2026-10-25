/**
 * @dropway/client: typed REST client for Kofra, generated from the operation
 * registry (`npm run client:generate`). Fetch-only: runs on Node, Workers and
 * browsers. The CLI's transport builds on this package.
 */
export {
  DropwayError,
  DropwayHttpClient,
  errorFromResponse,
  movedTo,
  normaliseApi,
  type ApiResponse,
  type BytesResult,
  type CallOptions,
  type ClientOptions,
  type FetchLike,
  type OperationMeta,
  type RequestOptions,
} from "./http.ts";
export { DropwayClient, OPERATIONS } from "./generated.ts";
export type * from "./generated.ts";
export { VERSION } from "./version.ts";
