/**
 * The backend-neutral doctor contract (ADR 0030 Decision 6). Doctor is a facet
 * of the store backend that owns the data, not a vault-shaped module the
 * composition root assembles: the backend answers `diagnose`, `facet`, and —
 * only where a mutation transport asked for it — `repair`, and every value that
 * crosses this seam is backend-neutral.
 *
 * Nothing here names a document, a path, or a migration plan. A finding's
 * `locator` is an opaque human-readable string, and a repair `recipe` /
 * `reason` is an opaque vocabulary word the backend chooses and the CLI prints
 * verbatim. The Norn backend's implementation lives under `./norn`.
 */
import type { DoctorFacet } from './facet';

/** One problem a backend found, anchored for a human to locate and fix. */
export type DoctorFinding = {
  /** Stable machine code. Each backend owns its own closed code vocabulary. */
  code: string;
  /** The reporting check's name. */
  check: string;
  /** An informational triage label, never a gate (ADR 0017): `error` = a record
   * the reader drops (data lost/hidden on read); `warn` = content the reader
   * tolerates but that looks like an intended record. Doctor always exits 0 on a
   * successful run regardless of severity. */
  severity: 'error' | 'warn';
  /** The offending node's `KEY-seq` stem. */
  node: string;
  /** Where in the record, e.g. `History · line 6`. */
  where: string;
  /** A one-line human description of the problem. */
  message: string;
  /** Canonical ownership derived from the stem, never from stored metadata. */
  scopeKey: string;
  /** Canonical entity identity (kept alongside `node` for JSON compatibility). */
  stem: string;
  /** Stable structured facts used by repair policy and machine consumers. */
  evidence: Readonly<Record<string, unknown>>;
  /** An opaque backend locator for the issue — a vault path on Norn. */
  locator: string;
};

/** Metadata shared by every doctor transport so an absent/stale project scope
 * cannot be mistaken for a clean scan. Null when the run is unscoped. */
export type DoctorScopeMatch = { key: string; matched_documents: number } | null;

/** One diagnostic pass: what was found, and what the scope actually matched. */
export type DoctorDiagnosis = {
  findings: DoctorFinding[];
  scope: DoctorScopeMatch;
};

/** One issue the repair pass planned, fixed, or declined to touch. `recipe` and
 * `reason` are backend vocabulary words, printed verbatim by every transport. */
export type RepairItem = {
  issue: DoctorFinding;
  recipe?: string;
  reason?: string;
};

/** One repair that did not land, classified by which stage gave way. */
export type RepairFailure = {
  code: 'apply-failed' | 'apply-refused' | 'planning-failed' | 'verification-failed';
  message: string;
  issue?: DoctorFinding;
};

/** The whole outcome of one repair pass, ready to render. `outcome: 'failed'`
 * is the one nonzero-exit signal; `preview` and `applied` both exit 0. */
export type DoctorRepairReport = {
  /** Operational diagnostics are not issue outcomes and never inflate summary. */
  details: RepairFailure[];
  failed: RepairFailure[];
  fixed: RepairItem[];
  mode: 'apply' | 'dry-run';
  outcome: 'applied' | 'failed' | 'preview';
  planned: RepairItem[];
  /** What the requested scope matched, so an empty scope cannot read as clean. */
  scope: DoctorScopeMatch;
  skipped: RepairItem[];
  summary: { failed: number; fixed: number; planned: number; skipped: number };
};

/** A repair pass request. `dryRun` previews without mutating the store. */
export type DoctorRepairRequest = {
  dryRun: boolean;
  scope: string | undefined;
};

/**
 * The doctor facet of a store backend. `repair` is OPTIONAL and present only
 * where a mutating transport asked for it: the CLI composition root wires a
 * backend that carries it, while the read-only transports (`serve`, `mcp`)
 * intentionally receive one that does not, so the repair capability cannot be
 * reached over HTTP or MCP at all.
 */
export type DoctorBackend = {
  /** Run every check the backend knows, narrowed to `scope` when given. */
  diagnose: (scope: string | undefined) => Promise<DoctorDiagnosis>;
  /** The record-health facet the `/api/doctor` console panel consumes. */
  facet: (scope: string | undefined) => Promise<DoctorFacet>;
  /** Plan, apply, and verify the deterministic repairs. Absent on a read-only
   * wiring — `cmdDoctor` refuses `--fix` rather than pretending. */
  repair?: (request: DoctorRepairRequest) => Promise<DoctorRepairReport>;
};
