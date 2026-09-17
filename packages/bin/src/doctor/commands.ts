/**
 * The `mimir doctor` command (MMR-166) — ask the store backend for its
 * diagnosis and report it. The backend owns every check and every repair
 * (ADR 0030 Decision 6); this module is rendering, scope warnings, and the
 * exit-code contract, and it names nothing backend-specific.
 *
 * Output honors the CLI contract: findings print to stderr and a clean run
 * prints one line on stdout. Doctor is a **non-gating diagnostic** (ADR 0017):
 * it always exits `0` on a successful run regardless of findings — surfacing
 * issues _is_ its job — so a nonzero exit is reserved for doctor itself failing
 * (the backend read throws) or a repair pass reporting `outcome: 'failed'`.
 * Per-finding `error`/`warn` is an informational triage label, not an exit gate.
 * The `json` (pretty array) / `jsonl` (one finding per line) formats emit
 * findings on stdout, same exit-0 contract.
 */
import type { Format, Io } from '../presentation';
import { ok, warn } from '../presentation';
import type {
  DoctorBackend,
  DoctorRepairReport,
  DoctorScopeMatch,
  RepairFailure,
  RepairItem,
} from './contract';

function itemWire(item: RepairItem): Record<string, unknown> {
  return {
    code: item.issue.code,
    ...(item.reason === undefined ? {} : { reason: item.reason }),
    ...(item.recipe === undefined ? {} : { recipe: item.recipe }),
    scopeKey: item.issue.scopeKey,
    stem: item.issue.stem,
  };
}

function failureWire(failure: RepairFailure): Record<string, unknown> {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.issue === undefined
      ? {}
      : {
          issueCode: failure.issue.code,
          scopeKey: failure.issue.scopeKey,
          stem: failure.issue.stem,
        }),
  };
}

function reportWire(report: DoctorRepairReport): Record<string, unknown> {
  return {
    ...(report.details.length === 0 ? {} : { details: report.details.map(failureWire) }),
    failed: report.failed.map(failureWire),
    fixed: report.fixed.map(itemWire),
    mode: report.mode,
    outcome: report.outcome,
    planned: report.planned.map(itemWire),
    skipped: report.skipped.map(itemWire),
    summary: report.summary,
  };
}

function renderRepair(io: Io, format: Format, report: DoctorRepairReport): void {
  if (format === 'json') {
    io.write(JSON.stringify(reportWire(report), null, 2));
    return;
  }
  if (format === 'jsonl') {
    const records = [
      ...report.planned.map((item) => ({ ...itemWire(item), status: 'planned' })),
      ...report.fixed.map((item) => ({ ...itemWire(item), status: 'fixed' })),
      ...report.skipped.map((item) => ({ ...itemWire(item), status: 'skipped' })),
      ...report.failed.map((failure) => ({ ...failureWire(failure), status: 'failed' })),
      ...report.details.map((detail) => ({ ...failureWire(detail), status: 'detail' })),
      { ...report.summary, mode: report.mode, outcome: report.outcome, status: 'summary' },
    ];
    io.write(records.map((record) => JSON.stringify(record)).join('\n'));
    return;
  }
  const primary = report.mode === 'dry-run' ? report.planned : report.fixed;
  for (const item of primary) {
    io.write(
      `[${report.mode === 'dry-run' ? 'planned' : 'fixed'}] ${item.issue.code} ${item.issue.stem}: ${item.recipe ?? ''}`,
    );
  }
  for (const item of report.skipped) {
    io.write(`[skipped] ${item.issue.code} ${item.issue.stem}: ${item.reason ?? ''}`);
  }
  for (const failure of report.failed) {
    io.error(
      `[failed] ${failure.issue?.code ?? failure.code}${failure.issue === undefined ? '' : ` ${failure.issue.stem}`}: ${failure.message}`,
    );
  }
  for (const detail of report.details) {
    io.error(`[detail] ${detail.code}: ${detail.message}`);
  }
  io.write(
    `doctor repair ${report.mode === 'dry-run' ? 'preview' : report.outcome}: ${String(report.summary.planned)} planned, ${String(report.summary.fixed)} fixed, ${String(report.summary.skipped)} skipped, ${String(report.summary.failed)} failed`,
  );
}

/** An absent or stale project scope must never read as a clean scan. */
function warnEmptyScope(io: Io, match: DoctorScopeMatch): void {
  if (match?.matched_documents === 0) {
    warn(io, `doctor scope '${match.key}' matched 0 documents`);
  }
}

async function cmdDoctorRepair(
  io: Io,
  doctor: DoctorBackend,
  format: Format,
  scope: string | undefined,
  dryRun: boolean,
): Promise<number> {
  if (doctor.repair === undefined) {
    throw new Error('doctor repair is unavailable in this context');
  }
  const report = await doctor.repair({ dryRun, scope });
  warnEmptyScope(io, report.scope);
  renderRepair(io, format, report);
  // `failed` is the one nonzero signal; `preview` and `applied` both exit 0.
  return report.outcome === 'failed' ? 1 : 0;
}

export async function cmdDoctor(
  io: Io,
  doctor: DoctorBackend,
  format: Format,
  scope: string | undefined,
  repair?: { dryRun: boolean; fix: boolean },
): Promise<number> {
  if (repair?.fix === true) {
    return cmdDoctorRepair(io, doctor, format, scope, repair.dryRun);
  }
  // One backend pass answers both the findings and what the scope matched, so a
  // stale `-s` can never be mistaken for a clean store.
  const { findings, scope: match } = await doctor.diagnose(scope);
  warnEmptyScope(io, match);

  if (format === 'jsonl') {
    // One finding per line — the NDJSON contract every mimir surface honors.
    io.write(findings.map((f) => JSON.stringify(f)).join('\n'));
  } else if (format === 'json') {
    io.write(JSON.stringify(findings, null, 2));
  } else if (findings.length === 0) {
    ok(io, 'doctor: no problems found');
  } else {
    // Findings are the loud channel: each on stderr, tagged by its informational
    // severity — rendered as the tier-1 short spelling (`[err]`/`[warn]`, never
    // `[error]`), so `error` never reads as a `warn`. The wire `severity` field
    // keeps its `error`/`warn` vocabulary; only the human tag is short.
    for (const f of findings) {
      const tag = f.severity === 'error' ? 'err' : f.severity;
      io.error(`[${tag}] ${f.node}: ${f.message} (${f.where})`);
    }
  }

  // Non-gating (ADR 0017): a successful run always exits 0 — findings are the
  // output, not the status. A doctor-itself failure (the backend read above throws)
  // is never caught here, so the rejection propagates out and the process exits
  // nonzero — the reserved failure signal.
  return 0;
}
