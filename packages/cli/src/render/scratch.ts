/**
 * The styled views of the scratchpad reads and writes, ported from the old CLI. A pad
 * renders as its wire object, one `key  value` line per field with instants
 * in the reader's zone; the list is one dense row per pad. Layout is evolvable
 * and never parsed (ADR 0009).
 */
import { formatInstant, relativeTime } from '@mimir/helpers';

import type { Presentation } from './presentation';
import { compactJson, recordViews } from './views';

/**
 * The wire keys whose value is a display instant. `updated_at` is deliberately
 * absent: it is the optimistic-concurrency token a caller echoes back
 * byte-exact, so it stays the canonical UTC instant in every format.
 */
const INSTANT_KEYS = new Set(['created_at', 'freezing_at']);

function localizedJournalEntry(entry: unknown, zone: string): unknown {
  if (typeof entry !== 'object' || entry === null || !('at' in entry)) {
    return entry;
  }
  const { at } = entry;
  return typeof at === 'string' ? { ...entry, at: formatInstant(at, zone) } : entry;
}

/** A wire pad as a human reads it: instants and Journal stamps in the reader's zone. */
function localized(value: Record<string, unknown>, zone: string): [string, unknown][] {
  return Object.entries(value).map(([key, item]) => {
    if (INSTANT_KEYS.has(key) && typeof item === 'string') {
      return [key, formatInstant(item, zone)];
    }
    if (key === 'journal' && Array.isArray(item)) {
      return [key, item.map((entry) => localizedJournalEntry(entry, zone))];
    }
    return [key, item];
  });
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** `records` and `table` of one pad: its wire fields, one per line. */
export function renderScratchpad(wire: Record<string, unknown>, p: Presentation): string {
  return localized(wire, p.zone)
    .map(([key, item]) => `${key.replaceAll('_', ' ')}  ${renderValue(item)}`)
    .join('\n');
}

/** `records` and `table` of the pad list: one dense row per pad, a relative age last. */
export function renderScratchRows(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return '0 scratchpads';
  }
  const now = Date.now();
  return rows
    .map(
      (pad) =>
        `${pad.state === 'freezing' ? 'freezing  ' : ''}${String(pad.id)}  ${String(pad.project)}  ${String(pad.title)}  ${relativeTime(String(pad.updated_at), now)}`,
    )
    .join('\n');
}

/** A Scratchpad write's receipt, its wire object, and how the styled views render it. */
export type ScratchEcho = { wire: Record<string, unknown>; presentation: Presentation };

const receiptLines = (echo: Readonly<ScratchEcho>): string =>
  renderScratchpad(echo.wire, echo.presentation);

/**
 * The views of a Scratchpad write: the receipt as `key  value` lines on the
 * styled formats, and the receipt object on `json` and `jsonl`.
 */
export const scratchEchoViews = recordViews<ScratchEcho>({
  ids: (echo) => String(echo.wire.id ?? echo.wire.artifact),
  json: (echo) => compactJson(echo.wire),
  records: receiptLines,
});
