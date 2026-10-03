/**
 * The `/api/doctor` record-health facet (MMR-185) — the console projection of the
 * SAME findings `mimir doctor` reports. The CLI prints {@link DoctorFinding}s;
 * this facet groups them by owning project and adds the plain-language cause
 * chip the Record-health panel shows. Read-only: it names the row a human fixes
 * at the database; it never writes.
 *
 * The backend builds it (ADR 0030 Decision 6) from the one diagnosis it also
 * hands the CLI, so the panel can never drift from what `mimir doctor` reports.
 */
import type { DoctorFinding, DoctorScopeMatch } from './contract';

/** One finding as the Record-health panel renders it. */
export type DoctorRecord = {
  /** The finding's record identity — a `KEY-seq` stem, an artifact or
   * scratchpad id, or a project key. */
  id: string;
  /** The plain-language cause chip: `dangling parent`, `orphan link`, … */
  cause: string;
  /** The finding's informational triage label (ADR 0017) — never a gate. */
  severity: DoctorFinding['severity'];
  /** Where the row lives, `<table>/<key>` — the CLI finding's own `locator`. */
  locator: string;
  /** The offending column, when the finding names one. */
  field: string | null;
  /** The offending value verbatim, when it is a single string. */
  value: string | null;
  /** The structured facts behind the finding — the CLI finding's `evidence`. */
  evidence: Readonly<Record<string, unknown>>;
  /** A one-line plain-language explanation of the finding. */
  note: string;
};

/** The findings of one project. */
export type DoctorGroup = {
  /** The owning project key, or `store` for a store-level finding. */
  project: string;
  /** How many findings this project holds. */
  finding_count: number;
  records: DoctorRecord[];
};

/** The `/api/doctor` facet payload. `groups` is empty on a clean store (the
 * panel then shows its zero state and all surfacing is absent). */
export type DoctorFacet = {
  /** When this scan ran — the panel derives "last scan Ns ago" from it. */
  scanned_at: string;
  /** Total findings across every group — the surfacing count. */
  finding_total: number;
  groups: DoctorGroup[];
  /** Requested project scope plus how many records it holds. `null`
   * identifies a whole-store scan. This distinguishes a stale scope from a
   * genuinely clean scoped scan without inventing a diagnostic finding. */
  scope: DoctorScopeMatch;
};

/** The empty facet — the clean-store zero state, and the fallback for a caller
 * (e.g. a doctor-agnostic test server) that never wires a doctor facet provider. */
export function emptyDoctorFacet(): DoctorFacet {
  return { finding_total: 0, groups: [], scanned_at: new Date().toISOString(), scope: null };
}
