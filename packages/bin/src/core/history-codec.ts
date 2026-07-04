import type { HistoryEntry, TransitionKind } from '@mimir/contract';
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

const ARROW = ' → ';
const HEADING = /^### (.+?) — (.+)$/;

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
  if (entry.reason !== null) {
    lines.push(entry.reason);
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
  const reason = reasonLines.length > 0 ? reasonLines.join('\n') : null;

  return { at, from: edge.from, kind, reason, to: edge.to };
}

/** Parse the `## History` section body into its transitions, in document order. */
export function parseHistorySection(body: string): HistoryEntry[] {
  return splitRecords(body)
    .map(parseRecord)
    .filter((entry): entry is HistoryEntry => entry !== null);
}
