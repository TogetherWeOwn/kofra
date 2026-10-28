# Viewer limits: JSON, CSV and notebooks

Canonical limit reference for the JSON, CSV/TSV and Jupyter notebook viewers.
[SPEC §10.2](SPEC.md) summarises these rows; this page states the exact
constants so an agent can choose Rendered, Source, Raw or Download without
guessing. It describes the code in this repository (code-merged behaviour).
It is not evidence that any particular deployment is running that code:
a docs or code merge is not a deployed/runtime verification.

Units are explicit. Byte caps are bytes of the stored file. String limits
are JavaScript string lengths (UTF-16 code units), not bytes, because the
code compares `string.length`. `1 MiB = 1,048,576 bytes`.

Viewer selection is `findViewer`
([`packages/server/src/viewers/index.ts`](../packages/server/src/viewers/index.ts)):
the first viewer whose `maxBytes` is at least `file.size`
(`file.size <= maxBytes`) and whose `matches` accepts the file kind and view
mode wins. The response names the winner in `X-Kofra-Viewer`.

## At a glance

| Format | Accepted input cap (`maxBytes`) | Read budget for the rendered view | Rendered-output limits | Above the input cap |
|---|---|---|---|---|
| JSON (`.json`, `.geojson`, `.webmanifest`) | 2 MiB (2,097,152 bytes) | Whole file, only within the cap | Tree: 20,000 nodes; tree strings: 2,000; Pretty pane only when the pretty text is at most 1,048,576 | Code view (first 1 MiB shown), see Source below |
| CSV / TSV (`.csv`, `.tsv`) | No file-size cap for viewer selection (`Number.MAX_SAFE_INTEGER`) | First 4 MiB (4,194,304 bytes) | 2,000 data rows shown; 1,000 per cell; delimiter detection: 65,536 code units, 5 records | Not applicable: larger files still get the CSV viewer, bounded by the read/row limits |
| Notebook (`.ipynb`) | 20 MiB (20,971,520 bytes) | Whole file, only within the cap | 100,000 per clipped output text (see below) | Code view (first 1 MiB shown), see Source below |

## JSON

Source: [`packages/server/src/viewers/json.ts`](../packages/server/src/viewers/json.ts).

- Input cap: `jsonViewer.maxBytes = 2 * 1024 * 1024` (2,097,152 bytes).
  At exactly that size the JSON viewer still runs; one byte above it does not.
- Tree node budget: `MAX_NODES = 20,000`. When the budget runs out, the tree
  stops expanding that level and shows `… N more (see the Pretty or Raw view)`.
- Tree string limit: `MAX_STRING = 2,000`. Longer strings are cut in the tree
  with a trailing `…`; the Pretty pane, when present, has them whole.
- Pretty limit: `MAX_PRETTY = 1024 * 1024` (1,048,576) on
  `JSON.stringify(parsed, null, 2).length`. Above it there is no Pretty tab or
  pane; the Tree remains. This is a limit on the pretty-printed output, not
  on the input file.
- Malformed input: within the cap, invalid JSON still gets the JSON viewer:
  a parse-error notice above the highlighted source text. A leading U+FEFF
  byte order mark is stripped before parsing.
- JSON search is **planned, not shipped** (SPEC VIEW-03, roadmap R-34). Do
  not rely on it, and do not describe it as done.

## CSV and TSV

Source: [`packages/server/src/viewers/csv.ts`](../packages/server/src/viewers/csv.ts).

- Input cap: `csvViewer.maxBytes = Number.MAX_SAFE_INTEGER`. There is no
  file-size refusal for choosing the CSV viewer.
- Read budget: `READ_MAX_BYTES = 4 * 1024 * 1024` (4,194,304 bytes). Only the
  first 4 MiB are read for the table; a partial read can drop a final row cut
  mid-record.
- Row limit: `MAX_ROWS = 2,000` data rows are shown. The parser is asked for
  `MAX_ROWS + 1` rows in total because the first row is the header row (below).
- Cell limit: `MAX_CELL = 1,000`. Longer cell values are cut with a trailing
  `…` in the table.
- Delimiter detection (not header detection): `DETECT_SAMPLE_CHARS = 64 * 1024`
  (65,536 UTF-16 code units) and `DETECT_MAX_RECORDS = 5` complete nonempty
  logical records vote among comma, tab, semicolon and pipe, counting only
  candidates outside quoted fields. `.tsv` always selects tab. Ties and
  no-evidence inputs fall back to comma in that candidate order.
- **Header: the first row is always shown as the header.** `renderCsvTable`
  takes `rows[0]` as the `<thead>` row and the remaining rows as the body.
  There is no header detection: a file with no header row shows its first
  data row as the header and does not count it as a data row.
- Counts: the meta line reports data rows (with `+` and a "showing the first
  … rows of …" note when the read or row limit cut the table), the column
  count (the widest rendered row) and the detected delimiter name.
- An empty parse shows "This file has no rows." The RFC 4180-style parser is
  lenient: there is no malformed-CSV error view.
- Sortable/filterable tables and header detection are **planned, not
  shipped** (SPEC VIEW-03, roadmap R-34).

## Notebooks (`.ipynb`)

Source: [`packages/server/src/viewers/notebook.ts`](../packages/server/src/viewers/notebook.ts).

- Input cap: `notebookViewer.maxBytes = 20 * 1024 * 1024`
  (20,971,520 bytes). At exactly that size the notebook viewer still runs;
  one byte above it does not.
- Output clip: `MAX_OUTPUT_TEXT = 100,000`, applied by `clip()` to each of:
  stream output text, error tracebacks, `text/plain` output data and the
  stringified `application/json` output data. Clipped text keeps the first
  100,000 and adds a newline plus `…`. It does not clip code-cell or raw-cell
  source, Markdown cells, `text/html`/`text/markdown` outputs or image
  outputs; those are bounded by the input cap and the HTML sanitizer.
- Malformed input: within the cap, a notebook that is not valid JSON shows a
  short note naming the parse error and pointing at Source or Raw, instead of
  cells. Nothing in a notebook executes.

## Source, Raw and Download (all three formats)

These query conventions are stable and relative to the file's own URL on the
sites origin (for example `/s/<slug>/data/table.csv` in path mode, or
`/<path>` on a subdomain-mode site host). They change only the
representation, never the access decision: expiry, password gates and any
other serving gate run before `serveFile` chooses a view
([`packages/server/src/serve.ts`](../packages/server/src/serve.ts)), so
`?raw=1`, `?download=1` and `?view=source` do not bypass them. Transfer
deliveries never use these viewers; they always download.

| Request | Representation | Exact bytes? |
|---|---|---|
| Navigation, or `?view=1` | Rendered viewer above if within its cap; JSON and notebooks above their cap fall through to the code viewer (kind `json`/`notebook` is in its kind set) | No: rendered HTML |
| `?view=source` | `sourceViewer` ([`packages/server/src/viewers/code.ts`](../packages/server/src/viewers/code.ts)): highlighted source for the text kinds `json`, `csv` and `notebook`; shows at most `SHOW_MAX_BYTES = 1024 * 1024` (1,048,576 bytes) with a truncation note above that | No: rendered HTML, possibly truncated |
| `?raw=1` | The stored bytes; text types are relabelled `text/plain; charset=utf-8` (original type in `X-Kofra-Original-Content-Type`) so a browser shows rather than renders them | Yes, for a full (non-Range) GET |
| `?download=1` | The stored bytes with `Content-Disposition: attachment` and the file's base name (non-ASCII names get an ASCII `filename` fallback plus the real UTF-8 name in RFC 5987 `filename*`) | Yes, for a full (non-Range) GET |
| Sub-resource request (`fetch()`, `<img>`, `<script>`, `curl` without navigation headers) | No viewer is chosen; the stored bytes. Path-mode HTML/CSS URL rewriting does not apply to these formats | Yes, for a full (non-Range) GET |

To fetch exact bytes, use `?raw=1` or `?download=1` (or any non-navigation
request) and compare a SHA-256 of the body with the published file's
SHA-256. Do not scrape the Rendered or Source HTML expecting file bytes:
both reformat, escape and may truncate.

Highlighting note: Source and the over-cap code fallback are highlighted
only while the shown text is at most `HIGHLIGHT_MAX_BYTES = 512 * 1024`
(524,288 by string length,
[`packages/server/src/viewers/highlight.ts`](../packages/server/src/viewers/highlight.ts));
above that the same text is shown escaped as plain text with a note.

## Image and SVG backgrounds

The raster-image and SVG viewers offer **Checker** (default), **Light** (white)
and **Dark** (black) backgrounds for visually inspecting artwork. The selection
changes only the image stage, not the page theme or the file. It does not detect
transparency or certify contrast or accessibility; opaque pixels keep their own
colors.

The labelled native radio group works without JavaScript. Tab to the selected
background, then use the arrow keys to change it; the checked circle and bold
label identify the selection, and a visible outline identifies keyboard focus.
**Actual size** remains a separate checkbox: Space toggles between fitting the
image and its natural size without resetting the background. Clicking the image
also toggles sizing. Large Actual-size images remain scrollable, and the controls
wrap above the stage on narrow screens. Fit uses the space remaining after the
actual wrapped controls and header, rather than a fixed header-height allowance.
If controls exhaust a very short window, the stage retains a usable minimum
height and the document can scroll instead of collapsing the image to zero.
Image-viewer chrome stays in normal document flow so it cannot cover a control
when native keyboard focus scrolls it into view. The inspection paint layer keeps
its checker/white/black colors in forced-colors mode; the controls and their focus
indicators still use the system's forced-color adaptation.

The same controls are available with `?view=1&embed=1`. A bare iframe or image
sub-resource still receives the original file. SVGs remain isolated through
`<img>`; their scripts do not run. The raster viewer still reads only the first
65,536 bytes (or the whole file if smaller) for dimensions, and the SVG viewer
reads no file bytes to build its page.

Selection is local to the current document: it is not saved or encoded in the
URL. No script, canvas, external asset, extra storage read or background-query
cache variant is added. Raw/Download/sub-resource bytes, headers and ranges are
unchanged. The image and SVG viewer versions invalidate the former rendered-page
validators when these controls change.

Verification contracts:
[`test/image-backgrounds.acceptance.test.ts`](../test/image-backgrounds.acceptance.test.ts)
and
[`packages/cli/test/encrypted/image-backgrounds.browser.acceptance.test.ts`](../packages/cli/test/encrypted/image-backgrounds.browser.acceptance.test.ts).
The browser suite serves a disposable local Worker and uses transparent light/dark
PNG/SVG fixtures plus an opaque PNG across light/dark themes at 360 and 1100 px.
It checks all three backgrounds with both sizing states using the keyboard with
scripts disabled, including stage pixels, focus, scrolling and unchanged requests.
These contracts are not evidence of a particular deployed version.

## Printing reports

Markdown, code/text (including Source), JSON, CSV/TSV and notebook documents
have an inline, print-only stylesheet. Browser Print / Save as PDF uses black
text on white, hides viewer navigation and action controls, and keeps the file
path as context, including in embedded documents. Long code and table cells
wrap; exposed content is not limited to a scrolling viewport. CSV headers repeat
across pages and rows avoid splitting when they fit on a page. Table widths
adapt to the paper; exceptionally tall rows may span pages.

Printing preserves closed details, folded notebook outputs and the selected
JSON Tree or Pretty pane. It does **not** recover data omitted by any of the
limits above: truncation notices and ellipses remain. Use Raw or Download for
the complete stored bytes. No new print button, script or network request is
needed; screen styles, CSP and access gates are unchanged. HTML applications
and their embedded pages keep their own printing behavior.

Printed path context does not include request URLs or append link destinations.
The browser's optional URL headers/footers are a separate print-dialog setting:
disable them when printing a sensitive URL. Document-authored text is not
redacted.

## Agent verification matrix

Linking existing tests; this page does not assert they were run. Run them
yourself before relying on a boundary:

```sh
npx vitest run test/viewers.test.ts test/csv-delimiter.acceptance.test.ts
npm run guard
npm run check
```

[`test/viewers.test.ts`](../test/viewers.test.ts) covers viewer selection
(including a JSON file above its cap falling back to the code viewer),
the JSON tree/pretty and invalid-JSON views, the CSV table and the notebook
view. [`test/csv-delimiter.acceptance.test.ts`](../test/csv-delimiter.acceptance.test.ts)
covers delimiter detection budgets, the 2,000-row and 4 MiB render limits,
and raw/download returning the full file.

For a published file at `<file-url>`, check each format at its boundaries:

| Check | How | Expected |
|---|---|---|
| Below / at cap | Publish a file just below, then at, 2,097,152 bytes (JSON) or 20,971,520 bytes (notebook); open it as a navigation (`?view=1`) | `X-Kofra-Viewer: json` / `notebook` |
| Above cap | One byte above the same cap; open as a navigation | `X-Kofra-Viewer: code`, first 1,048,576 bytes shown with a truncation note; use Raw for the bytes |
| CSV read / row cut | Publish a CSV over 4,194,304 bytes, and one with over 2,000 data rows | `X-Kofra-Viewer: csv`; meta line says "showing the first 2,000 rows of …" (or fewer when the 4 MiB read cuts first); no file-size refusal |
| CSV header assumption | Publish a headerless CSV | First data row renders as the table header and is not counted as a data row |
| Malformed input | Publish invalid JSON as `.json` and as `.ipynb` | JSON: parse-error notice over highlighted source. Notebook: "not valid JSON" note pointing at Source/Raw. CSV has no error view |
| Raw identity | `curl -s '<file-url>?raw=1' \| sha256sum` against the published file's SHA-256 | Equal hashes; `Content-Type: text/plain; charset=utf-8` |
| Download identity | `curl -s '<file-url>?download=1' \| sha256sum` | Equal hashes; `Content-Disposition: attachment` |
| Source is not bytes | Open `?view=source` for a file over 1,048,576 bytes | Truncation note present; do not diff this HTML against the file |

No API, CLI or mutation behaviour is defined or changed by this page, so
JSON/error shapes, idempotency and dry-run behaviour are not applicable here.
