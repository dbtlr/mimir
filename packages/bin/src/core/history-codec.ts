import type { AnnotationView, HistoryEntry, TransitionKind } from '@mimir/contract';
import { TRANSITION_KIND_VALUES } from '@mimir/contract';

/**
 * The `## History` record codec (MMR-153): the single grammar the vault write
 * path (this slice) and the read path (MMR-154) share, so a transition round-
 * trips losslessly through markdown.
 *
 * One transition is one H3 sub-section under `## History`:
 *
 *   ### <ISO> — <kind>
 *   <from> → <to>
 *   <reason?>
 *
 * The transition line is the sole edge carrier. A two-sided change (lifecycle,
 * hold, archive, subtree move) renders `from → to`; a one-sided edge change
 * renders the present side prefixed — `+to` when an edge was added (`from` is
 * null) and `-from` when one was removed (`to` is null). The optional reason is
 * everything after the edge line (multi-line and unicode preserved), with a
 * trailing blank line dropped.
 */

/** The `## History` section heading (H2) — the anchor the writer appends under. */
export const HISTORY_HEADING = 'History';

/** The `## Annotations` section heading (H2) — the anchor `annotate` appends under. */
export const ANNOTATIONS_HEADING = 'Annotations';

/** The `## Task Description` section heading (H2) — the node body's prose lede. */
export const DESCRIPTION_HEADING = 'Task Description';

/**
 * The document body every work-state node carries: a `## Task Description` lede
 * (the authoritative home for the prose since MMR-162 — read back through
 * {@link parseDescriptionSection}, no longer a frontmatter field), the
 * `## History` section the transition log appends under (MMR-153), and the
 * `## Annotations` section `annotate` appends under (MMR-154). Both append
 * anchors MUST be present at create time — Norn's `append_to_section` refuses a
 * missing heading — so a create seeds them empty.
 */
export function renderNodeBody(description: string | null): string {
  return `## ${DESCRIPTION_HEADING}\n${renderDescriptionSection(description)}${renderHistoryBody()}${renderAnnotationsBody()}`;
}

/**
 * The body of the `## Task Description` section (the content *under* the heading,
 * heading excluded) — the payload a `replace_section` op hands norn when a
 * node's `description` is edited, and what a create seeds. Since MMR-162 this
 * section is **authoritative** for the prose (the frontmatter copy is gone), so
 * it round-trips through {@link parseDescriptionSection}.
 *
 * Heading-shaped lines are escaped: a description line like `## History` would
 * otherwise be an injected section boundary that {@link sliceBodySection}
 * matches ahead of the real anchor, shadowing the History/Annotations facets —
 * and, now that the section is parsed back, it would also corrupt the recovered
 * description. `parseDescriptionSection` unescapes them, so the prose is exact.
 */
export function renderDescriptionSection(description: string | null): string {
  return `\n${escapeBodyLines(description ?? '')}\n\n`;
}

/** A project/container body: just the `## History` section the log appends under. */
export function renderHistoryBody(): string {
  return `## ${HISTORY_HEADING}\n`;
}

/**
 * A node body with its `## History` and `## Annotations` sections *populated* —
 * the authoritative migration's reconstruction (MMR-155) from a node's
 * transition/annotation rows. Same shape as {@link renderNodeBody} (identical
 * when both are empty), so the Norn read path slices and parses it back to the
 * exact records. History and annotations arrive already in their intended order.
 */
export function renderMigratedNodeBody(
  description: string | null,
  history: readonly HistoryEntry[],
  annotations: readonly AnnotationView[],
): string {
  return (
    `## ${DESCRIPTION_HEADING}\n${renderDescriptionSection(description)}` +
    `${renderHistoryBody()}${history.map(renderHistoryRecord).join('')}` +
    `${renderAnnotationsBody()}${annotations.map(renderAnnotationRecord).join('')}`
  );
}

/** A project body with its `## History` reconstructed (archive transitions are
 * project-keyed); projects carry no `## Annotations` section. */
export function renderMigratedProjectBody(history: readonly HistoryEntry[]): string {
  return `${renderHistoryBody()}${history.map(renderHistoryRecord).join('')}`;
}

/** An empty `## Annotations` section — the append anchor a fresh node seeds. */
export function renderAnnotationsBody(): string {
  return `## ${ANNOTATIONS_HEADING}\n`;
}

const ARROW = ' → ';
const HEADING = /^### (.+?) — (.+)$/;

/**
 * A reason line that is itself a markdown heading (`#`..`######` + space) is a
 * write-path injection hazard: a `### ` line would be read back as a *new*
 * transition record by {@link splitRecords}, and a `## `/`# ` line would close
 * the enclosing `## History` section outright (Norn's `append_to_section`
 * writes verbatim). The codec escapes such lines with a leading backslash on
 * render and strips it on parse, so an arbitrary reason round-trips losslessly.
 */
// The escape must be injective: a reason line already carrying leading
// backslashes (`\## note`) must not collide with the escape of a bare heading.
// Escape prepends ONE backslash to any `<zero-or-more \>#{1,6} <space>` line;
// unescape strips ONE from any `<one-or-more \>#{1,6} <space>` line — exact
// inverses, so every reason line round-trips byte-for-byte.
const HEADING_LINE = /^\\*#{1,6}\s/;
const ESCAPED_HEADING_LINE = /^\\+#{1,6}\s/;

function escapeBodyLines(body: string): string {
  return body
    .split('\n')
    .map((line) => (HEADING_LINE.test(line) ? `\\${line}` : line))
    .join('\n');
}

function unescapeBodyLines(body: string): string {
  return body
    .split('\n')
    .map((line) => (ESCAPED_HEADING_LINE.test(line) ? line.slice(1) : line))
    .join('\n');
}

function isTransitionKind(value: string): value is TransitionKind {
  return (TRANSITION_KIND_VALUES as readonly string[]).includes(value);
}

/** The edge line for a transition — `from → to`, or `+to` / `-from` when one-sided. */
function renderEdge(from: string | null, to: string | null): string {
  if (from !== null && to !== null) {
    return `${from}${ARROW}${to}`;
  }
  if (to !== null) {
    return `+${to}`;
  }
  if (from !== null) {
    return `-${from}`;
  }
  return '—';
}

/** Parse an edge line back into its `from`/`to` sides; null when unrecognized. */
function parseEdge(line: string): { from: string | null; to: string | null } | null {
  if (line === '—') {
    return { from: null, to: null };
  }
  const arrow = line.indexOf(ARROW);
  if (arrow !== -1) {
    return { from: line.slice(0, arrow), to: line.slice(arrow + ARROW.length) };
  }
  if (line.startsWith('+')) {
    return { from: null, to: line.slice(1) };
  }
  if (line.startsWith('-')) {
    return { from: line.slice(1), to: null };
  }
  return null;
}

/** Render one transition as the `### …` block to hand to `appendToSection`. */
export function renderHistoryRecord(entry: HistoryEntry): string {
  const lines = [`### ${entry.at} — ${entry.kind}`, renderEdge(entry.from, entry.to)];
  // An empty or whitespace-only reason is indistinguishable from `null` after a
  // round-trip (the parser strips trailing blank lines), so normalize it to
  // "no reason line" here — render and parse then agree on `reason: null`.
  if (entry.reason !== null && entry.reason.trim() !== '') {
    lines.push(escapeBodyLines(entry.reason));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Group the section body into H3 blocks — each opens on a line the caller's
 * `isBoundary` predicate accepts as a record heading, and runs to the next such
 * line (its own body absorbs everything between).
 *
 * The boundary is the record *grammar*, not a bare `### ` (MMR-161, hazard F4).
 * Mimir-written records escape heading-shaped body lines, so a `### ` inside a
 * reason or annotation only ever appears in a *hand edit* — and anchoring the
 * split on the grammar keeps such a line as content of its enclosing record
 * instead of splitting one record into two (and silently shedding the orphaned
 * tail). A hand edit that reproduces the full heading grammar is still read as a
 * record boundary; that is inherent (it is indistinguishable from a real one).
 */
function splitRecords(body: string, isBoundary: (line: string) => boolean): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    if (isBoundary(line)) {
      if (current !== null) {
        blocks.push(current);
      }
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) {
    blocks.push(current);
  }
  return blocks;
}

/** Parse one H3 block back into a {@link HistoryEntry}; null when it isn't one. */
function parseRecord(lines: string[]): HistoryEntry | null {
  const [headingLine, ...rest] = lines;
  if (headingLine === undefined) {
    return null;
  }
  const heading = HEADING.exec(headingLine);
  if (heading === null) {
    return null;
  }
  const [, at, kind] = heading;
  if (at === undefined || kind === undefined || !isTransitionKind(kind)) {
    return null;
  }

  // The edge is the first non-empty body line; the reason is everything after.
  const edgeIndex = rest.findIndex((line) => line.trim() !== '');
  if (edgeIndex === -1) {
    return null;
  }
  const edge = parseEdge(rest[edgeIndex] ?? '');
  if (edge === null) {
    return null;
  }

  const reasonLines = rest.slice(edgeIndex + 1);
  while (reasonLines.length > 0 && reasonLines[reasonLines.length - 1] === '') {
    reasonLines.pop();
  }
  const reason = reasonLines.length > 0 ? unescapeBodyLines(reasonLines.join('\n')) : null;

  return { at, from: edge.from, kind, reason, to: edge.to };
}

/**
 * Parse the `## Task Description` section body back to the description string —
 * the inverse of {@link renderDescriptionSection}: recover heading-escaped lines
 * and drop the section's leading/trailing blank-line framing. Internal blank
 * lines (paragraph breaks) survive; an empty section reads as null. Body-
 * authoritative since MMR-162 (ADR 0016 Refinement).
 */
export function parseDescriptionSection(body: string): string | null {
  const text = unescapeBodyLines(body).trim();
  return text === '' ? null : text;
}

/**
 * A `## History` record opens on an H3 heading of the record shape
 * `### <at> — <kind>` ({@link HEADING}). Anchoring the split here (MMR-161) means
 * a hand-typed `### …` line inside a reason — one lacking the ` — <kind>` tail —
 * stays part of that reason rather than splitting the record.
 */
function isHistoryBoundary(line: string): boolean {
  return HEADING.test(line);
}

/** Parse the `## History` section body into its transitions, in document order. */
export function parseHistorySection(body: string): HistoryEntry[] {
  return splitRecords(body, isHistoryBoundary)
    .map(parseRecord)
    .filter((entry): entry is HistoryEntry => entry !== null);
}

// ── Annotations ──────────────────────────────────────────────────────────
// The same H3-per-record grammar as History, minus the edge line: an
// annotation has no durable id (the SQLite surrogate is never surfaced) and no
// kind, so the heading carries only the created-at ISO and the whole body under
// it is the note content. Trailing blank lines normalize away like a History
// reason — content is otherwise byte-preserved (heading-shaped lines escaped).

// An annotation record opens on `### <createdAt>`, where the created-at is the
// ISO-8601 instant both backends stamp (`strftime('%Y-%m-%dT%H:%M:%fZ')` /
// JS `toISOString`). Anchoring the heading to that shape — rather than any
// `### ` line — keeps a hand-typed `### some heading` inside annotation prose
// from being read as a new record boundary (MMR-161, hazard F4).
const ANNOTATION_HEADING =
  /^### (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)$/;

/** Render one annotation as the `### …` block to hand to `appendToSection`. */
export function renderAnnotationRecord(view: AnnotationView): string {
  return `### ${view.createdAt}\n${escapeBodyLines(view.content)}\n`;
}

/** Parse one H3 block back into an {@link AnnotationView}; null when it isn't one. */
function parseAnnotationRecord(lines: string[]): AnnotationView | null {
  const [headingLine, ...rest] = lines;
  if (headingLine === undefined) {
    return null;
  }
  const heading = ANNOTATION_HEADING.exec(headingLine);
  const createdAt = heading?.[1];
  if (createdAt === undefined) {
    return null;
  }
  // The content is the whole body under the heading; drop the trailing blank
  // lines the record terminator and inter-record spacing introduce, then
  // recover any escaped heading-shaped lines.
  while (rest.length > 0 && rest[rest.length - 1] === '') {
    rest.pop();
  }
  return { content: unescapeBodyLines(rest.join('\n')), createdAt };
}

/** A `## Annotations` record opens on an H3 `### <ISO createdAt>` heading — the
 * boundary and the parse extractor share {@link ANNOTATION_HEADING}. */
function isAnnotationBoundary(line: string): boolean {
  return ANNOTATION_HEADING.test(line);
}

/** Parse the `## Annotations` section body into its notes, in document order. */
export function parseAnnotationsSection(body: string): AnnotationView[] {
  return splitRecords(body, isAnnotationBoundary)
    .map(parseAnnotationRecord)
    .filter((view): view is AnnotationView => view !== null);
}

/**
 * Isolate one `## <heading>` section's body from a whole document body — the
 * Norn read path's client-side slicer over `.body` (the NRN-102 `.headings`
 * workaround, since section-scoped reads aren't a Norn capability yet). Returns
 * the lines under the heading up to the next H2 (`## `) or EOF, heading
 * excluded; an absent heading yields the empty string. The record grammar keeps
 * this unambiguous: H3 records (`### `) and escaped `\## ` content lines are not
 * H2 boundaries, so a section round-trips through slice + parse.
 */
export function sliceBodySection(body: string, heading: string): string {
  const lines = body.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) {
    return '';
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}
