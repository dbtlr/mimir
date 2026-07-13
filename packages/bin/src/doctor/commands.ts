/**
 * The `mimir doctor` command (MMR-166) — run the vault diagnostics registry and
 * report. A vault-only surface: the body-section records it checks live in
 * hand-editable markdown. `readSnapshot` is the injected whole-vault diagnostic
 * read handle.
 *
 * Output honors the CLI contract: findings print to stderr and a clean run
 * prints one line on stdout. Doctor is a **non-gating diagnostic** (ADR 0017):
 * it always exits `0` on a successful run regardless of findings — surfacing
 * issues _is_ its job — so a nonzero exit is reserved for doctor itself failing
 * (the vault read throws). Per-finding `error`/`warn` is an informational triage
 * label, not an exit gate. The `json` (pretty array) / `jsonl` (one finding per
 * line) formats emit findings on stdout, same exit-0 contract.
 */
import type { Format, Io } from '../cli/render';
import { ok } from '../cli/render';
import { now } from '../core/time';
import type { MigrationPlan } from '../norn/plan';
import type { DoctorFinding } from './checks';
import { diagnoseDoctor } from './diagnosis';
import type { DoctorRepairPlan, RepairItem } from './repair';
import { planDoctorRepairs, repairIssueKey } from './repair';
import type { DoctorSnapshot } from './snapshot';

export type DoctorDeps = {
  /** Read every diagnostic input from one whole-vault enumeration (MMR-241). */
  readSnapshot: () => Promise<DoctorSnapshot>;
  /** CLI-only mutation capability. Read-only transports intentionally do not
   * receive this dependency. */
  repair?: {
    applyPlan: (plan: MigrationPlan, confirm: boolean) => Promise<unknown>;
    vaultRoot: string;
  };
};

type RepairFailure = {
  code: 'apply-failed' | 'apply-refused' | 'planning-failed' | 'verification-failed';
  message: string;
  issue?: DoctorFinding;
};

type DoctorRepairReport = {
  /** Operational diagnostics are not issue outcomes and never inflate summary. */
  details: RepairFailure[];
  failed: RepairFailure[];
  fixed: RepairItem[];
  mode: 'apply' | 'dry-run';
  outcome: 'applied' | 'failed' | 'preview';
  planned: RepairItem[];
  skipped: RepairItem[];
  summary: { failed: number; fixed: number; planned: number; skipped: number };
};

function applyOutcome(report: unknown): string | undefined {
  if (!isRecord(report)) {
    return undefined;
  }
  const envelope = report;
  const root = isRecord(envelope.report) ? envelope.report : envelope;
  return typeof root.outcome === 'string' ? root.outcome : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyFailure(outcome: string | undefined, report: unknown): RepairFailure {
  const base = `norn apply outcome: ${outcome ?? 'unrecognized'}`;
  const detail = outcome === 'failed' ? `; report: ${JSON.stringify(report)}` : '';
  return {
    code: outcome === 'refused' ? 'apply-refused' : 'apply-failed',
    message: `${base}${detail}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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

function finishReport(args: Omit<DoctorRepairReport, 'summary'>): DoctorRepairReport {
  return {
    ...args,
    summary: {
      failed: args.failed.length,
      fixed: args.fixed.length,
      planned: args.planned.length,
      skipped: args.skipped.length,
    },
  };
}

async function cmdDoctorRepair(
  io: Io,
  deps: DoctorDeps,
  format: Format,
  scope: string | undefined,
  dryRun: boolean,
): Promise<number> {
  if (deps.repair === undefined) {
    throw new Error('doctor repair is unavailable in this context');
  }
  const snapshot = await deps.readSnapshot();
  const issues = await diagnoseDoctor(snapshot, scope);
  const plan: DoctorRepairPlan = planDoctorRepairs({
    issues,
    scope,
    snapshot,
    timestamp: now(),
    vaultRoot: deps.repair.vaultRoot,
  });
  const planningFailures: RepairFailure[] = plan.failures.map((failure) => ({
    code: 'planning-failed',
    issue: failure.issue,
    message: failure.reason,
  }));
  if (planningFailures.length > 0) {
    const unapplied: RepairFailure[] = plan.planned.map((item) => ({
      code: 'planning-failed',
      issue: item.issue,
      message: 'repair plan not applied because planning failed',
    }));
    const report = finishReport({
      details: [],
      failed: [...planningFailures, ...unapplied],
      fixed: [],
      mode: dryRun ? 'dry-run' : 'apply',
      outcome: 'failed',
      planned: [],
      skipped: plan.skipped,
    });
    renderRepair(io, format, report);
    return 1;
  }

  if (plan.migration.operations.length === 0) {
    const report = finishReport({
      details: [],
      failed: [],
      fixed: [],
      mode: dryRun ? 'dry-run' : 'apply',
      outcome: dryRun ? 'preview' : 'applied',
      planned: dryRun ? plan.planned : [],
      skipped: plan.skipped,
    });
    renderRepair(io, format, report);
    return 0;
  }

  let rawApply: unknown;
  let thrown: unknown;
  try {
    rawApply = await deps.repair.applyPlan(plan.migration, !dryRun);
  } catch (error) {
    thrown = error;
  }
  const outcome = thrown === undefined ? applyOutcome(rawApply) : undefined;

  if (dryRun) {
    if (thrown !== undefined || outcome !== 'applied') {
      const failure: RepairFailure =
        thrown === undefined
          ? applyFailure(outcome, rawApply)
          : { code: 'apply-failed', message: `norn apply threw: ${errorMessage(thrown)}` };
      const report = finishReport({
        details: [failure],
        failed: plan.planned.map((item) => ({
          code: failure.code,
          issue: item.issue,
          message: 'repair plan validation failed',
        })),
        fixed: [],
        mode: 'dry-run',
        outcome: 'failed',
        planned: [],
        skipped: plan.skipped,
      });
      renderRepair(io, format, report);
      return 1;
    }
    const report = finishReport({
      details: [],
      failed: [],
      fixed: [],
      mode: 'dry-run',
      outcome: 'preview',
      planned: plan.planned,
      skipped: plan.skipped,
    });
    renderRepair(io, format, report);
    return 0;
  }

  const applyFailures: RepairFailure[] = [];
  if (thrown !== undefined) {
    applyFailures.push({
      code: 'apply-failed',
      message: `norn apply threw: ${errorMessage(thrown)}`,
    });
  } else if (outcome !== 'applied') {
    applyFailures.push(applyFailure(outcome, rawApply));
  }

  let fixed: RepairItem[] = [];
  let verificationFailures: RepairFailure[] = [];
  const verificationDetails: RepairFailure[] = [];
  try {
    const postIssues = await diagnoseDoctor(await deps.readSnapshot(), scope);
    const residual = new Set(postIssues.map(repairIssueKey));
    fixed = plan.planned.filter((item) => !residual.has(repairIssueKey(item.issue)));
    verificationFailures = plan.planned
      .filter((item) => residual.has(repairIssueKey(item.issue)))
      .map((item) => ({
        code: 'verification-failed',
        issue: item.issue,
        message: 'issue remains after apply',
      }));
  } catch (error) {
    verificationFailures = plan.planned.map((item) => ({
      code: 'verification-failed',
      issue: item.issue,
      message: 'post-apply result indeterminate',
    }));
    verificationDetails.push({
      code: 'verification-failed',
      message: `post-apply diagnosis failed: ${errorMessage(error)}`,
    });
  }
  const details = [...applyFailures, ...verificationDetails];
  const failed = verificationFailures;
  const success = outcome === 'applied' && details.length === 0 && failed.length === 0;
  const report = finishReport({
    details,
    failed,
    fixed,
    mode: 'apply',
    outcome: success ? 'applied' : 'failed',
    planned: [],
    skipped: plan.skipped,
  });
  renderRepair(io, format, report);
  return success ? 0 : 1;
}

export async function cmdDoctor(
  io: Io,
  deps: DoctorDeps,
  format: Format,
  scope: string | undefined,
  repair?: { dryRun: boolean; fix: boolean },
): Promise<number> {
  if (repair?.fix === true) {
    return cmdDoctorRepair(io, deps, format, scope, repair.dryRun);
  }
  // One shared post-refresh document set serves bodies, graph/declarations, and
  // section diagnostics. The projection keeps MMR-240's authoritative stem scope
  // while the unfiltered snapshot remains available to MMR-183's repair planner.
  const findings = await diagnoseDoctor(await deps.readSnapshot(), scope);

  if (format === 'jsonl') {
    // One finding per line — the NDJSON contract every mimir surface honors.
    io.write(findings.map((f) => JSON.stringify(f)).join('\n'));
  } else if (format === 'json') {
    io.write(JSON.stringify(findings, null, 2));
  } else if (findings.length === 0) {
    ok(io, 'doctor: no problems found');
  } else {
    // Findings are the loud channel: each on stderr, tagged by its informational
    // severity label (there is no per-severity render glyph, and `error` must not
    // read as a `warn`).
    for (const f of findings) {
      io.error(`[${f.severity}] ${f.node}: ${f.message} (${f.where})`);
    }
  }

  // Non-gating (ADR 0017): a successful run always exits 0 — findings are the
  // output, not the status. A doctor-itself failure (the vault read above throws)
  // is never caught here, so the rejection propagates out and the process exits
  // nonzero — the reserved failure signal.
  return 0;
}
