import { escapeHtml } from "../html";

/** Metadata for generated views only. `url` is the query-free, encoded file/listing URL. */
export function unfurlHead(opts: { title: string; description: string; url: string; image?: boolean }): string {
  const title = escapeHtml(opts.title);
  const description = escapeHtml(opts.description);
  // Enforce the query-free contract here: emitted URLs are percent-encoded, so a
  // literal ? or # can only be a query/fragment (never cite request tokens).
  const url = escapeHtml(opts.url.split(/[?#]/, 1)[0]!);
  return `<meta name="robots" content="noindex">
<meta property="og:title" content="${title}">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:description" content="${description}">
<meta name="description" content="${description}">
<meta name="twitter:card" content="${opts.image ? "summary_large_image" : "summary"}">${opts.image ? `\n<meta property="og:image" content="${url}">` : ""}`;
}
