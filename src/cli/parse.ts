/**
 * Shared parse helpers for flag values used by both read commands (run.ts) and
 * write-verb handlers (mutations.ts). Extracted to avoid a run ↔ mutations
 * import cycle: run.ts imports handlers from mutations.ts, so mutations.ts must
 * not import from run.ts.
 */

import { PRIORITY_VALUES, SIZE_VALUES, type Priority, type Size } from "../contract";
import { usage } from "./errors";

export function parsePriority(value: string | undefined): Priority | undefined {
  if (value === undefined) return undefined;
  if (!(PRIORITY_VALUES as readonly string[]).includes(value)) {
    throw usage(`invalid priority: ${value} (expected ${PRIORITY_VALUES.join("|")})`);
  }
  return value as Priority;
}

export function parseSize(value: string | undefined): Size | undefined {
  if (value === undefined) return undefined;
  if (!(SIZE_VALUES as readonly string[]).includes(value)) {
    throw usage(`invalid size: ${value} (expected ${SIZE_VALUES.join("|")})`);
  }
  return value as Size;
}
