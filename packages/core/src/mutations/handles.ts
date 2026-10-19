import { HANDLE_FIELD_ARGS, HANDLE_FIELD_KEYS } from '@mimir/contract';
import type { ExecutionHandles, HandleFieldArg, HandleFieldKey } from '@mimir/contract';

import { hasRedundantWorker } from '../assignment';
import { validation } from '../errors';
import { flattenHandle, HANDLE_SEP, isEchoSafeHandle } from '../history-codec';
import type { Node } from '../model';
import type { NodePatch } from '../store';

/**
 * The resume-handle machinery (ADR 0026 Decision 3, MMR-320) — the in-flight
 * fields' shared read/write rules, in one module because they have exactly two
 * boundaries and both must agree:
 *
 * - the WRITE boundary ({@link normalizeHandle}, behind `create`/`start`/`update`)
 *   normalizes a value to one line and REFUSES one the `## History` echo could not
 *   carry back verbatim;
 * - the ECHO boundary ({@link handlesOf}, behind every claiming/clearing
 *   transition) reads stored bytes and FLATTENS them, so a stored value the
 *   write path would have refused can neither forge a transition row nor block
 *   the verb (ADR 0017 runtime tolerance — bad field data degrades
 *   the field, it never fails a mutation).
 *
 * The legality rule itself lives with the grammar it protects, in
 * `history-codec.ts`; this module is where the two boundaries bind to it.
 */

/**
 * The patch slice the resume handles occupy — what `create`/`start` record and
 * `update` overwrites. Structurally the {@link UpdateFields} subset for these
 * keys; declared standalone so the codec-side machinery here doesn't depend on
 * the whole `update` vocabulary (`data.ts` compile-checks the correspondence).
 */
export type MainHandleFields = Pick<HandleFields, 'branch' | 'harness' | 'host' | 'session'>;
export type HandleFields = Partial<Record<HandleFieldArg, string | null>>;

/**
 * Normalize a resume-handle value at the WRITE boundary (MMR-320): whitespace
 * collapses to single spaces and the result is trimmed, so a handle is always one
 * `## History` line; an empty/whitespace-only result stores as `null`, which is
 * how a plain `update` CLEARS a handle (`--host ''`). A `null` input passes
 * through untouched. No cap — a handle is an opaque key into a richer store, not
 * prose (ADR 0026 Decision 3).
 *
 * A value the echo could not carry back verbatim — one holding the log's ` · `
 * field separator — is a HARD REJECT, never silently rewritten: stored as-is it
 * would read back as an additional handle that was never set (`--host 'a ·
 * session=x'` forging a session), and silently mangling a caller's value is the
 * same class of dishonesty as truncating an over-long summary. Whitespace is the
 * one shape normalized rather than refused, matching `normalizeSummary`'s
 * newline collapse.
 */
export function normalizeHandle(value: string | null, field: HandleFieldKey): string | null {
  if (value === null) {
    return null;
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!isEchoSafeHandle(collapsed)) {
    throw validation(
      `${field} cannot contain '${HANDLE_SEP.trim()}' surrounded by spaces`,
      'the transition log uses it to separate the handles it records',
    );
  }
  return collapsed === '' ? null : collapsed;
}

/**
 * Copy the SET resume handles from a patch onto a {@link NodePatch}, normalized —
 * the one binding `create`, `start`, and `update` share, so no door can store a
 * value another would refuse. {@link HANDLE_FIELD_ARGS} maps each persisted
 * snake_case field to its camelCase argument.
 */
export function applyHandlePatch(patch: NodePatch, fields: HandleFields): void {
  for (const key of HANDLE_FIELD_KEYS) {
    const value = fields[HANDLE_FIELD_ARGS[key]];
    if (value !== undefined) {
      patch[key] = normalizeHandle(value, key);
    }
  }
  // A supplied worker session establishes its own identity; an omitted harness stays unknown.
  if (fields.workerSession !== undefined && fields.workerHarness === undefined) {
    patch.worker_harness = null;
  }
}

/**
 * The resume handles a task currently carries, omit-when-absent — the ECHO
 * boundary: the record a claiming or clearing transition writes onto its
 * `## History` row, and the emptiness test the clearing verbs branch on.
 *
 * Presence is decided by the STORED value (so `clearHandles` nulls exactly the
 * columns that hold something), but the reported value is {@link flattenHandle}'d.
 * That is the whole forgery guard: the edge line is written verbatim — unlike a
 * reason, it is never heading-escaped — so a stored multi-line value (an older
 * write, or an imported one) would otherwise inject a whole extra `### ` record
 * (or close the section) and a separator-bearing one would read back as a
 * handle nobody set. Flattening here cannot throw, so such a value degrades its
 * own echo instead of blocking `done`.
 */
export function handlesOf(task: Node): ExecutionHandles {
  const handles: ExecutionHandles = {};
  for (const key of HANDLE_FIELD_KEYS) {
    const value = task[key];
    if (value !== null) {
      handles[key] = flattenHandle(value);
    }
  }
  return handles;
}

/**
 * Add the resume-handle clears to a mutation's node patch, and return what was
 * cleared for the transition row (ADR 0026 Decision 3): the terminal transitions
 * (`done`, `abandon`) and the holds (`park`, `block`) drop the handles, because
 * the work is no longer in flight and a stale pointer is worse than none. Only
 * the SET handles are nulled, so an unclaimed task's transition writes no extra
 * column. `submit`/`return` deliberately do NOT call this — the branch and
 * session stay the live pointers at the human gate — and `reopen`/`unpark`/
 * `unblock` restore nothing: a resuming agent re-states them via `update`.
 */
export function clearHandles(patch: NodePatch, task: Node): ExecutionHandles {
  const cleared = handlesOf(task);
  for (const key of HANDLE_FIELD_KEYS) {
    if (cleared[key] !== undefined) {
      patch[key] = null;
    }
  }
  return cleared;
}

/** Main conversation and optional whole-task worker identity, including nulls for lossless audit snapshots. */
export function assignmentOf(task: Node) {
  return {
    harness: task.harness,
    session: task.session,
    worker_harness: task.worker_harness,
    worker_session: task.worker_session,
  };
}

/** Validate a complete identity after a patch, and omit a redundant same-agent worker. */
export function validateAssignment(patch: NodePatch, task: Node): void {
  const next = { ...task, ...patch };
  if (
    next.worker_harness !== null &&
    (next.worker_session === null || next.worker_session.trim() === '')
  ) {
    throw validation('worker harness requires a nonblank worker session');
  }
  if (
    next.worker_session !== null &&
    next.worker_session.trim() !== '' &&
    (next.session === null || next.session.trim() === '')
  ) {
    throw validation('worker session requires a nonblank main session');
  }
  if (hasRedundantWorker(next)) {
    patch.worker_session = null;
    patch.worker_harness = null;
  }
}
