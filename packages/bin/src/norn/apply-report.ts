/**
 * The shared decoder for a norn `vault.apply` report (MMR-250). norn 0.45+
 * (NRN-150/175/183) returns a structured report whose envelope is
 * double-nested: a precondition refusal wraps the report one level down under
 * `report.report` (with `isError: true`) while a plain apply returns it at the
 * root. The unwrap, the `outcome` read, the operations-array access, and the
 * per-op field reads (`op_id`/`kind`/`status`/`stem`/`error`) had been copied
 * — and had begun to drift — across the node write path (`norn/writer.ts`), the
 * artifact store (`core/artifacts/norn.ts`), and the seed store
 * (`core/seeds/norn.ts`). This is the one home for that RAW decode.
 *
 * Deliberately RAW: it normalizes the envelope and fields, nothing more. Each
 * consumer keeps its own verdict/classification — the node write path's
 * drift-vs-terminal `classifyApply`, the stores' terminal single-create checks
 * — because those policies legitimately differ (the seed/artifact stores reject
 * the drift-replay verdict by design). Absent or foreign-typed fields decode to
 * `null` so a degraded report never reads as a false success.
 *
 * Two lighter entry points sit alongside the full decode: `applyReportOutcome`
 * for a caller that reads only `outcome` (the seed germinate/apply-outcome
 * path), and `createdStem` for the create read-back the artifact and seed
 * stores both ran byte-identically on their single-create apply.
 */

import { isStringRecord } from './decode';

/** A failed op's `{ code, message }`, each `null` when absent or non-string. */
export type ApplyReportOpError = {
  code: string | null;
  message: string | null;
};

/**
 * One operation line of an apply report (norn 0.45 / NRN-175), every field
 * narrowed to a string or `null`. `opId` is the op's plan position (norn echoes
 * the emit index as `op_id`); `stem` is the resolved `KEY-seq` on an applied
 * create; `error` is present only when the op carries a structured error object.
 */
export type ApplyReportOp = {
  opId: string | null;
  kind: string | null;
  status: string | null;
  stem: string | null;
  error: ApplyReportOpError | null;
};

/** A decoded apply report: norn's `outcome` (`null` when absent/non-string) and
 * every structured operation line, in report order. */
export type ApplyReport = {
  outcome: string | null;
  operations: ApplyReportOp[];
};

/** Unwrap the envelope: a precondition refusal doubles-nests the report one
 * level down under `report.report`, while a plain apply returns it at the
 * root. Shared by every decode entry point below. */
function unwrapReport(report: unknown): unknown {
  return isStringRecord(report) && isStringRecord(report.report) ? report.report : report;
}

/** Decode the raw `vault.apply` result — unwrap the `report.report` double
 * nesting, read `outcome`, and normalize each operation line. Non-record ops are
 * dropped; a non-array `operations` (or a non-record report) yields no ops. */
export function decodeApplyReport(report: unknown): ApplyReport {
  const root = unwrapReport(report);
  const outcome = isStringRecord(root) && typeof root.outcome === 'string' ? root.outcome : null;
  const rawOps = isStringRecord(root) && Array.isArray(root.operations) ? root.operations : [];
  const operations = rawOps.flatMap((op) => (isStringRecord(op) ? [decodeOp(op)] : []));
  return { operations, outcome };
}

/** The light decode for a caller that reads only `outcome` (MMR-250) — the
 * envelope unwrap plus the `outcome` read, without paying for the full
 * operations-array normalization {@link decodeApplyReport} does. Shares the
 * unwrap with it so the two never drift on the double-nesting rule. */
export function applyReportOutcome(report: unknown): string | null {
  const root = unwrapReport(report);
  return isStringRecord(root) && typeof root.outcome === 'string' ? root.outcome : null;
}

/**
 * The read-back of a single-create apply report (MMR-250): the resolved
 * `create_document` stem when `outcome` is `'applied'` and that op carries a
 * string stem; otherwise the assembled failure detail — `apply outcome:
 * <outcome ?? 'unrecognized'>`, plus ` — code: message` built from whichever of
 * the failed op's `error.code`/`error.message` are present. This is the exact
 * read-back the artifact store and the seed store both ran on their create
 * path; each keeps its own `throw validation(...)` wording and its own parse
 * of the returned stem. `restoreArtifact` does NOT use this — its collision
 * branch needs the raw op error for an `/already exists/` match, so it calls
 * {@link decodeApplyReport} directly.
 */
export function createdStem(report: unknown): { stem: string } | { failure: string } {
  const { operations, outcome } = decodeApplyReport(report);
  const op = operations.find((o) => o.kind === 'create_document');
  if (outcome === 'applied' && op !== undefined && op.stem !== null) {
    return { stem: op.stem };
  }
  const errorDetail = [op?.error?.code, op?.error?.message]
    .filter((value): value is string => value != null)
    .join(': ');
  return {
    failure: `apply outcome: ${outcome ?? 'unrecognized'}${errorDetail === '' ? '' : ` — ${errorDetail}`}`,
  };
}

function decodeOp(op: Record<string, unknown>): ApplyReportOp {
  const error = isStringRecord(op.error)
    ? {
        code: typeof op.error.code === 'string' ? op.error.code : null,
        message: typeof op.error.message === 'string' ? op.error.message : null,
      }
    : null;
  return {
    error,
    kind: typeof op.kind === 'string' ? op.kind : null,
    opId: typeof op.op_id === 'string' ? op.op_id : null,
    status: typeof op.status === 'string' ? op.status : null,
    stem: typeof op.stem === 'string' ? op.stem : null,
  };
}
