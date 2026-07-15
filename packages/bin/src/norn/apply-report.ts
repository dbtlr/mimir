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

/** Decode the raw `vault.apply` result — unwrap the `report.report` double
 * nesting, read `outcome`, and normalize each operation line. Non-record ops are
 * dropped; a non-array `operations` (or a non-record report) yields no ops. */
export function decodeApplyReport(report: unknown): ApplyReport {
  const root = isStringRecord(report) && isStringRecord(report.report) ? report.report : report;
  const outcome = isStringRecord(root) && typeof root.outcome === 'string' ? root.outcome : null;
  const rawOps = isStringRecord(root) && Array.isArray(root.operations) ? root.operations : [];
  const operations = rawOps.flatMap((op) => (isStringRecord(op) ? [decodeOp(op)] : []));
  return { operations, outcome };
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
