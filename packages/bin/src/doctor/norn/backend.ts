/**
 * The Norn backend's implementation of the neutral doctor contract (ADR 0030
 * Decision 6). Everything vault-shaped — the whole-vault snapshot, the document
 * check registry, the migration-plan repair planner, the raw-Markdown fetch —
 * lives under this directory and is reached only through {@link DoctorBackend}.
 *
 * `repair` is produced only when the caller supplies the apply handles. The CLI
 * composition root supplies them; `serve` and `mcp` deliberately do not, so a
 * read-only transport holds a backend with no repair capability at all rather
 * than one that refuses at call time.
 */
import type { NornClient } from '../../core/store-norn/client';
import type { MigrationPlan } from '../../core/store-norn/plan';
import { now } from '../../core/time';
import type {
  DoctorBackend,
  DoctorDiagnosis,
  DoctorRepairReport,
  DoctorRepairRequest,
  RepairFailure,
  RepairItem,
} from '../contract';
import type { DoctorFacet } from '../facet';
import { diagnoseDoctor } from './diagnosis';
import { computeDoctorFacet } from './facet';
import type { DoctorRepairPlan } from './repair';
import { planDoctorRepairs, repairIssueKey } from './repair';
import type { DoctorSnapshot } from './snapshot';
import { doctorScopeMatch, readDoctorSnapshot } from './snapshot';

/** The vault handles the Norn doctor facet runs on. Injectable so a test can
 * drive the whole facet from a hand-built snapshot without a `norn` binary. */
export type NornDoctorDeps = {
  /** One whole-vault diagnostic enumeration, shared by every doctor pass (MMR-241). */
  readSnapshot: () => Promise<DoctorSnapshot>;
  /** Each path's exact on-disk text (frontmatter + body) — the location and
   * snippet enrichment source for the `/api/doctor` facet (MMR-185). */
  readRaw: (paths: string[]) => Promise<{ path: string; raw: string }[]>;
  /** The mutation handles. Present only on a CLI wiring; omitting them yields a
   * backend whose `repair` is undefined. */
  apply?: {
    applyPlan: (plan: MigrationPlan, confirm: boolean) => Promise<unknown>;
    vaultRoot: string;
  };
};

/**
 * Adapt a live Norn client into the doctor handles. `repair` decides whether the
 * resulting backend carries the mutation capability — the composition root's one
 * explicit read-only/read-write choice.
 */
export function nornDoctorDeps(
  client: NornClient,
  vaultRoot: string,
  opts: { repair: boolean },
): NornDoctorDeps {
  return {
    ...(opts.repair
      ? { apply: { applyPlan: (plan, confirm) => client.applyPlan(plan, confirm), vaultRoot } }
      : {}),
    readRaw: (paths) => client.readRawDocuments(paths),
    readSnapshot: () => readDoctorSnapshot(client),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Norn reports the apply outcome either bare or wrapped in a `report` envelope. */
function applyOutcome(report: unknown): string | undefined {
  if (!isRecord(report)) {
    return undefined;
  }
  const root = isRecord(report.report) ? report.report : report;
  return typeof root.outcome === 'string' ? root.outcome : undefined;
}

function applyFailure(outcome: string | undefined, report: unknown): RepairFailure {
  const base = `norn apply outcome: ${outcome ?? 'unrecognized'}`;
  const detail = outcome === 'failed' ? `; report: ${JSON.stringify(report)}` : '';
  return {
    code: outcome === 'refused' ? 'apply-refused' : 'apply-failed',
    message: `${base}${detail}`,
  };
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

/**
 * Plan, apply, and verify the deterministic repairs for `scope` (MMR-183). A
 * dry run still dispatches the plan to Norn with `confirm: false` so the
 * preview is a real validation, not a guess.
 */
async function runRepair(
  deps: NornDoctorDeps & { apply: NonNullable<NornDoctorDeps['apply']> },
  { dryRun, scope }: DoctorRepairRequest,
): Promise<DoctorRepairReport> {
  const snapshot = await deps.readSnapshot();
  const scopeMatch = doctorScopeMatch(snapshot, scope);
  const mode = dryRun ? 'dry-run' : 'apply';
  const issues = await diagnoseDoctor(snapshot, scope);
  const plan: DoctorRepairPlan = planDoctorRepairs({
    issues,
    scope,
    snapshot,
    timestamp: now(),
    vaultRoot: deps.apply.vaultRoot,
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
    return finishReport({
      details: [],
      failed: [...planningFailures, ...unapplied],
      fixed: [],
      mode,
      outcome: 'failed',
      planned: [],
      scope: scopeMatch,
      skipped: plan.skipped,
    });
  }

  if (plan.migration.operations.length === 0) {
    return finishReport({
      details: [],
      failed: [],
      fixed: [],
      mode,
      outcome: dryRun ? 'preview' : 'applied',
      planned: dryRun ? plan.planned : [],
      scope: scopeMatch,
      skipped: plan.skipped,
    });
  }

  let rawApply: unknown;
  let thrown: unknown;
  try {
    rawApply = await deps.apply.applyPlan(plan.migration, !dryRun);
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
      return finishReport({
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
        scope: scopeMatch,
        skipped: plan.skipped,
      });
    }
    return finishReport({
      details: [],
      failed: [],
      fixed: [],
      mode: 'dry-run',
      outcome: 'preview',
      planned: plan.planned,
      scope: scopeMatch,
      skipped: plan.skipped,
    });
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

  // Re-diagnose the same scope: an issue that survives the apply is a
  // verification failure, never a silent success.
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
  const success =
    outcome === 'applied' && details.length === 0 && verificationFailures.length === 0;
  return finishReport({
    details,
    failed: verificationFailures,
    fixed,
    mode: 'apply',
    outcome: success ? 'applied' : 'failed',
    planned: [],
    scope: scopeMatch,
    skipped: plan.skipped,
  });
}

/** Build the Norn doctor facet over the given vault handles. */
export function createNornDoctorBackend(deps: NornDoctorDeps): DoctorBackend {
  const apply = deps.apply;
  return {
    diagnose: async (scope): Promise<DoctorDiagnosis> => {
      const snapshot = await deps.readSnapshot();
      return {
        findings: await diagnoseDoctor(snapshot, scope),
        scope: doctorScopeMatch(snapshot, scope),
      };
    },
    facet: (scope): Promise<DoctorFacet> => computeDoctorFacet(deps, scope),
    // Read-only transports intentionally do not receive this capability.
    ...(apply === undefined ? {} : { repair: (request) => runRepair({ ...deps, apply }, request) }),
  };
}
