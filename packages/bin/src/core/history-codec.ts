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
 * (the human prose; `description` also rides frontmatter for the Phase-2b
 * reader), the `## History` section the transition log appends under (MMR-153),
 * and the `## Annotations` section `annotate` appends under (MMR-154). Both
 * append anchors MUST be present at create time — Norn's `append_to_section`
 * refuses a missing heading — so a create seeds them empty.
 */
export function renderNodeBody(description: string | null): string {
  return `## ${DESCRIPTION_HEADING}\n${renderDescriptionSection(description)}${renderHistoryBody()}${renderAnnotationsBody()}`;
}

/**
 * The body of the `## Task Description` section (the content *under* the heading,
 * heading excluded) — the payload a `replace_section` op hands norn when a
 * node's `description` is edited, so the prose section stays in lockstep with the
 * `description` frontmatter {@link renderNodeBody} seeds at create.
 */
export function renderDescriptionSection(description: string | null): string {
  return `\n${description ?? ''}\n\n`;
}

/** A project/container body: just the `## History` section the log appends under. */
export function renderHistoryBody(): string {
  return `## ${HISTORY_HEADING}\n`;
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

/** Group the section body into H3 blocks — each starts at a `### ` line. */
function splitRecords(body: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('### ')) {
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

/** Parse the `## History` section body into its transitions, in document order. */
export function parseHistorySection(body: string): HistoryEntry[] {
  return splitRecords(body)
    .map(parseRecord)
    .filter((entry): entry is HistoryEntry => entry !== null);
}

// ── Annotations ──────────────────────────────────────────────────────────
// The same H3-per-record grammar as History, minus the edge line: an
// annotation has no durable id (the SQLite surrogate is never surfaced) and no
// kind, so the heading carries only the created-at ISO and the whole body under
// it is the note content. Trailing blank lines normalize away like a History
// reason — content is otherwise byte-preserved (heading-shaped lines escaped).

const ANNOTATION_HEADING = /^### (.+)$/;

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

/** Parse the `## Annotations` section body into its notes, in document order. */
export function parseAnnotationsSection(body: string): AnnotationView[] {
  return splitRecords(body)
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
