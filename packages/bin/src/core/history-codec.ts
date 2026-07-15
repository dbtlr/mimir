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

/** The `## Seed Description` section heading (H2) — a seed's prose lede (MMR-244).
 * A seed's description is BODY prose, never frontmatter, exactly as a task's is. */
export const SEED_DESCRIPTION_HEADING = 'Seed Description';

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
  return renderSectionedBody(DESCRIPTION_HEADING, description);
}

/**
 * The full sectioned body a node/seed carries: a `## <heading>` prose lede followed
 * by the empty `## History` and `## Annotations` append anchors. The one shape
 * {@link renderNodeBody} and {@link renderSeedBody} share — only the description
 * heading differs (`Task Description` vs `Seed Description`).
 */
function renderSectionedBody(heading: string, description: string | null): string {
  return `## ${heading}\n${renderDescriptionSection(description)}${renderHistoryBody()}${renderAnnotationsBody()}`;
}

/**
 * A seed's document body (MMR-244): a `## Seed Description` prose lede, the
 * `## History` section its lifecycle transitions append under, and the
 * `## Annotations` section triage notes append under — the same full sectioned
 * shape a task carries, only the description heading differs (`Seed Description`
 * vs `Task Description`). Both append anchors are seeded empty so norn's
 * `append_to_section` has a heading to write under. Round-trips through the same
 * codec: {@link parseDescriptionSection}, {@link parseHistorySection}, and
 * {@link parseAnnotationsSection} over {@link sectionBody}.
 */
export function renderSeedBody(description: string | null): string {
  return renderSectionedBody(SEED_DESCRIPTION_HEADING, description);
}

/**
 * The body of the `## Task Description` section (the content *under* the heading,
 * heading excluded) — the payload a `replace_section` op hands norn when a
 * node's `description` is edited, and what a create seeds. Since MMR-162 this
 * section is **authoritative** for the prose (the frontmatter copy is gone), so
 * it round-trips through {@link parseDescriptionSection}.
 *
 * Heading-shaped lines are escaped: a description line like `## History` would
 * otherwise be an injected section boundary that norn's section read matches
 * ahead of the real anchor, shadowing the History/Annotations facets — and, now
 * that the section is parsed back, it would also corrupt the recovered
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

/**
 * Split a body into lines, tolerating CRLF (MMR-167). The codec's canonical line
 * ending is LF: a vault file saved with `\r\n` — a Windows editor, or git
 * `autocrlf` — leaves a trailing `\r` that the `$`-anchored heading regexes never
 * match, so without this every record would silently vanish on read. Both the
 * read splitters and the render/escape path route through here, so line endings
 * normalize to LF uniformly and a read and write agree: a CRLF-saved file reads
 * identically to its LF twin, and content authored with embedded CRLF is stored
 * and read back as LF (a line ending is structural, not content — the per-line
 * *content* still round-trips byte-for-byte through the escape). For LF input
 * this splits identically to `split('\n')`.
 */
function splitLines(body: string): string[] {
  return body.split(/\r?\n/);
}

/**
 * Normalize a body to the codec's canonical LF line ending (MMR-167) — the same
 * rule {@link splitLines} applies on read. Use it before comparing two bodies
 * for equality so a CRLF-re-saved file (Windows editor / git `autocrlf`) reads
 * as identical to its LF twin (MMR-172).
 */
export function toCanonicalLf(body: string): string {
  return splitLines(body).join('\n');
}

function escapeBodyLines(body: string): string {
  return splitLines(body)
    .map((line) => (HEADING_LINE.test(line) ? `\\${line}` : line))
    .join('\n');
}

function unescapeBodyLines(body: string): string {
  return splitLines(body)
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
  for (const line of splitLines(body)) {
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
 * A `## History` record opens on an H3 heading of the full record grammar —
 * `### <at> — <kind>` ({@link HEADING}) where `<kind>` is a known
 * {@link TransitionKind}, the same constraint {@link parseRecord} enforces.
 * Anchoring the split on the whole grammar (MMR-161) means a hand-typed `### …`
 * line inside a reason stays part of that reason rather than splitting the
 * record — whether it lacks the ` — <kind>` tail entirely or carries an
 * unrecognized kind (e.g. `### follow-up — see comments`). It mirrors the
 * annotation boundary, which likewise anchors on its full `### <ISO>` grammar.
 */
function isHistoryBoundary(line: string): boolean {
  const heading = HEADING.exec(line);
  return heading?.[2] !== undefined && isTransitionKind(heading[2]);
}

/** Parse the `## History` section body into its transitions, in document order. */
export function parseHistorySection(body: string): HistoryEntry[] {
  return splitRecords(body, isHistoryBoundary)
    .map(parseRecord)
    .filter((entry): entry is HistoryEntry => entry !== null);
}

// ── Annotations ──────────────────────────────────────────────────────────
// The same H3-per-record grammar as History, minus the edge line: an
// annotation has no durable id (no surrogate key is ever surfaced) and no
// kind, so the heading carries only the created-at ISO and the whole body under
// it is the note content. Trailing blank lines normalize away like a History
// reason — content is otherwise byte-preserved (heading-shaped lines escaped).

// An annotation record opens on `### <createdAt>`, where the created-at is the
// ISO-8601 instant the store stamps (JS `toISOString`). Anchoring the heading
// to that shape — rather than any
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
 * The body of a `## <heading>` section as the section parsers expect it — the
 * content *under* the heading, heading line excluded. norn's native section read
 * (`vault.get { section }`, NRN-102/NRN-173) returns each section with its `##
 * <heading>` line INCLUDED; this drops that first line so a native section read
 * feeds the codec identically to the retired whole-`.body` client slice (MMR-187).
 * An absent or empty section (the empty string) yields the empty string. The
 * parsers are grammar-anchored on `### ` records, so norn's trailing section
 * whitespace is absorbed on parse.
 *
 * The heading is only stripped when the first line is an actual `## ` heading — a
 * body content line is always escaped (`\## `), so an unescaped `## ` opener is
 * norn's heading and nothing else. Guarding on it means a section that ever
 * arrives heading-excluded (norn contract drift) is passed through intact rather
 * than losing its first real line.
 */
export function sectionBody(section: string): string {
  if (!section.startsWith('## ')) {
    return section;
  }
  const nl = section.indexOf('\n');
  return nl === -1 ? '' : section.slice(nl + 1);
}

/**
 * Slice one `## <heading>` section out of a WHOLE document body — the heading line
 * INCLUDED, through the line before the next H2 (`## `) or EOF; an absent heading
 * yields the empty string. Reproduces norn's `vault.get { section }` slice shape
 * (NRN-102/NRN-173) locally, so a caller already holding the `.body` (the seed
 * content read) can feed {@link sectionBody} exactly as a native section read would
 * — one fewer round-trip, and the record is returned even when the section is
 * ambiguous (a duplicate heading resolves to the FIRST here; native `getSections`
 * would warn-omit it and drop the whole doc from `records`). `mimir doctor`
 * surfaces the duplicate either way (MMR-239). norn is LF-canonical, so this
 * splits on `\n`.
 */
export function sliceSection(body: string, heading: string): string {
  const lines = body.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) {
    return '';
  }
  const relEnd = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const through = relEnd === -1 ? lines.length : start + 1 + relEnd;
  return lines.slice(start, through).join('\n');
}

// ── Body-section lint (MMR-166) ──────────────────────────────────────────
// The `mimir doctor` body-section check. The read path (MMR-161) is grammar-
// anchored, so it tolerate-and-skips a malformed `## History`/`## Annotations`
// record — silently dropping it or absorbing it into a neighbour, with no
// channel to warn. This is the additive counterpart: the INVERSE of the reader.
// It reports the records the reader can't cleanly read, for a human to fix.
//
// The writer always escapes heading-shaped body content (`escapeBodyLines`), so
// an UNescaped `### ` line inside a section only ever arrives via a hand edit.
// Every such line that is not a valid record boundary — or that opens a record
// whose body fails to parse — is a deviation from the write contract and is
// surfaced. Escaped `\### ` content lines are legitimate and never flagged, so
// anything the writer emits (including heading-ful reasons/annotations) lints
// clean — the round-trip guarantee, in reverse.

/** The classes of malformed body-section record `mimir doctor` reports. */
export type BodyRecordProblem =
  | 'unknown-transition-kind' // `### <at> — <kind>` whose kind is not a TransitionKind
  | 'malformed-history-heading' // an unescaped `### ` line that isn't record-shaped at all
  | 'unparseable-history-record' // a valid heading whose edge line is missing/unparseable
  | 'non-iso-annotation-heading'; // an unescaped `### ` line whose text isn't an ISO createdAt

/** One malformed record found in a node body, anchored to its line for a human to fix. */
export type BodyRecordFinding = {
  /** {@link HISTORY_HEADING} or {@link ANNOTATIONS_HEADING}. */
  section: string;
  /** 1-based line number within the node body. */
  line: number;
  /** The offending `### …` line, verbatim. */
  heading: string;
  problem: BodyRecordProblem;
};

/** The absolute `[start, end)` line span of a `## <heading>` section body. */
function sectionRange(lines: string[], heading: string): { start: number; end: number } | null {
  // Tolerate trailing whitespace on the H2 anchor (MMR-171): norn's native
  // resolver matches a `## History ` heading and reads the section, so doctor must
  // scan the same span — an exact match alone would miss it and silently skip the
  // section, a FALSE CLEAN (the worst failure for a diagnostic). MMR-167 already
  // normalized CRLF at the split; this covers trailing spaces/tabs. Prefer an EXACT
  // heading and fall back to a trailing-whitespace one only when none exists, so a
  // clean `## History` is never shadowed by an earlier whitespace-suffixed duplicate
  // (which would move the scan to the wrong span). A duplicate/shadowed heading is
  // norn's `section_failures` to report (MMR-239); the first-match here is deliberate.
  const target = `## ${heading}`;
  const exact = lines.indexOf(target);
  const anchor = exact !== -1 ? exact : lines.findIndex((l) => l.replace(/[ \t]+$/, '') === target);
  if (anchor === -1) {
    return null;
  }
  let end = anchor + 1;
  while (end < lines.length && !lines[end]?.startsWith('## ')) {
    end++;
  }
  return { end, start: anchor + 1 };
}

/**
 * Scan a node's raw markdown body for malformed `## History` / `## Annotations`
 * records — the pure detector behind `mimir doctor` (MMR-166). Returns one
 * finding per offending unescaped `### ` line, in document order; a clean body
 * (or one with no such sections — e.g. a project body has no Annotations) yields
 * no findings. Transport-agnostic: the caller reads the raw body from whichever
 * backend and hands it here.
 */
export function lintBodySections(body: string): BodyRecordFinding[] {
  const lines = splitLines(body);
  const findings: BodyRecordFinding[] = [];

  const history = sectionRange(lines, HISTORY_HEADING);
  if (history !== null) {
    for (let i = history.start; i < history.end; i++) {
      const line = lines[i] ?? '';
      if (ESCAPED_HEADING_LINE.test(line) || !line.startsWith('### ')) {
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading?.[2] === undefined) {
        findings.push(finding(HISTORY_HEADING, i, line, 'malformed-history-heading'));
      } else if (!isTransitionKind(heading[2])) {
        findings.push(finding(HISTORY_HEADING, i, line, 'unknown-transition-kind'));
      } else if (parseRecord(recordBlock(lines, i, history.end, isHistoryBoundary)) === null) {
        // A valid boundary whose edge line is missing/unparseable — the reader
        // drops the whole record, losing the transition.
        findings.push(finding(HISTORY_HEADING, i, line, 'unparseable-history-record'));
      }
    }
  }

  const annotations = sectionRange(lines, ANNOTATIONS_HEADING);
  if (annotations !== null) {
    for (let i = annotations.start; i < annotations.end; i++) {
      const line = lines[i] ?? '';
      if (ESCAPED_HEADING_LINE.test(line) || !line.startsWith('### ')) {
        continue;
      }
      // An annotation boundary carries only an ISO createdAt; content always
      // parses, so a valid heading is the only well-formed shape.
      if (!isAnnotationBoundary(line)) {
        findings.push(finding(ANNOTATIONS_HEADING, i, line, 'non-iso-annotation-heading'));
      }
    }
  }

  return findings;
}

function finding(
  section: string,
  index: number,
  heading: string,
  problem: BodyRecordProblem,
): BodyRecordFinding {
  return { heading, line: index + 1, problem, section };
}

/** The record block a boundary opens: its heading through to the next boundary
 * (or section end) — the same span {@link splitRecords} would hand the parser. */
function recordBlock(
  lines: string[],
  start: number,
  end: number,
  isBoundary: (line: string) => boolean,
): string[] {
  const block = [lines[start] ?? ''];
  for (let j = start + 1; j < end && !isBoundary(lines[j] ?? ''); j++) {
    block.push(lines[j] ?? '');
  }
  return block;
}
