/**
 * The backend-neutral doctor contract (ADR 0030 Decision 6). Doctor is a facet
 * of the store backend that owns the data: the backend answers `diagnose` and
 * `facet`, and every value that crosses this seam is backend-neutral. Both are
 * read-only — doctor reports, and a human fixes the row at the database.
 *
 * A finding's `locator` is an opaque human-readable string the backend chooses
 * and every transport prints verbatim.
 */
import type { DoctorFacet } from './facet';

/** One problem a backend found, anchored for a human to locate and fix. */
export type DoctorFinding = {
  /** Stable machine code. Each backend owns its own closed code vocabulary. */
  code: string;
  /** The reporting check's name. */
  check: string;
  /** An informational triage label, never a gate (ADR 0017): `error` = a broken
   * reference, or a schema this binary does not read; `warn` = a state that
   * reads fine today but will misbehave on a later write. Doctor always exits 0 on a
   * successful run regardless of severity. */
  severity: 'error' | 'warn';
  /** The offending node's `KEY-seq` stem. */
  node: string;
  /** Where in the record, e.g. `node · parent_id`. */
  where: string;
  /** A one-line human description of the problem. */
  message: string;
  /** Canonical ownership derived from the stem, never from stored metadata. */
  scopeKey: string;
  /** Canonical entity identity (kept alongside `node` for JSON compatibility). */
  stem: string;
  /** Stable structured facts for machine consumers and the console panel. */
  evidence: Readonly<Record<string, unknown>>;
  /** An opaque backend locator for the issue — `<table>/<key>` on the SQL store. */
  locator: string;
};

/** Metadata shared by every doctor transport so an absent/stale project scope
 * cannot be mistaken for a clean scan: how many records the scoped project
 * holds. Null when the run is unscoped. */
export type DoctorScopeMatch = { key: string; matched_records: number } | null;

/** Whether a doctor run spans the whole store: no project scope, or an empty one. */
export function isUnscoped(scope: string | undefined): scope is '' | undefined {
  return scope === undefined || scope === '';
}

/** One diagnostic pass: what was found, and what the scope actually matched. */
export type DoctorDiagnosis = {
  findings: DoctorFinding[];
  scope: DoctorScopeMatch;
};

/** The doctor facet of a store backend. */
export type DoctorBackend = {
  /** Run every check the backend knows, narrowed to `scope` when given. */
  diagnose: (scope: string | undefined) => Promise<DoctorDiagnosis>;
  /** The record-health facet the `/api/doctor` console panel consumes. */
  facet: (scope: string | undefined) => Promise<DoctorFacet>;
};
