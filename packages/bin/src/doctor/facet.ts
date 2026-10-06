/**
 * The `/api/doctor` record-health facet (MMR-185) — the console projection of the
 * SAME findings `mimir doctor` reports. The CLI prints {@link DoctorFinding}s;
 * this facet groups them by owning project and adds the plain-language cause
 * chip the Record-health panel shows. Read-only: it names the row a human fixes
 * at the database; it never writes.
 *
 * The backend builds it (ADR 0030 Decision 6) from the one diagnosis it also
 * hands the CLI, and `withConfigDoctor` adds the config-file findings to both
 * through {@link withFindings}, so the panel can never drift from what
 * `mimir doctor` reports.
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

/** The column a finding's `where` names, e.g. `node · parent_id` → `parent_id`. */
function fieldOf(where: string): string | null {
  const tail = where.split(' · ')[1];
  return tail === undefined || tail === '' ? null : tail;
}

/** One finding as a panel record: its locator and its own evidence, which is
 * what a human needs to reach and fix it. The evidence's `value` repeats a named
 * column already in it, so it moves to the record's own `value` rather than
 * rendering twice. */
function toRecord(item: DoctorFinding, causes: Readonly<Record<string, string>>): DoctorRecord {
  const { value, ...evidence } = item.evidence;
  return {
    cause: causes[item.code] ?? item.code,
    evidence,
    field: fieldOf(item.where),
    id: item.stem,
    locator: item.locator,
    note: item.message,
    severity: item.severity,
    value: typeof value === 'string' ? value : null,
  };
}

/**
 * Add `findings` to `facet`, each under its owning project's group, groups
 * sorted by key. `causes` maps a finding's `code` to the plain-language cause
 * chip; a code it lacks shows verbatim. The one projection from findings to the
 * panel, so every source of findings groups and renders alike.
 */
export function withFindings(
  facet: DoctorFacet,
  findings: readonly DoctorFinding[],
  causes: Readonly<Record<string, string>>,
): DoctorFacet {
  if (findings.length === 0) {
    return facet;
  }
  const groups = new Map(facet.groups.map((group) => [group.project, [...group.records]]));
  for (const item of findings) {
    const records = groups.get(item.scopeKey);
    if (records === undefined) {
      groups.set(item.scopeKey, [toRecord(item, causes)]);
    } else {
      records.push(toRecord(item, causes));
    }
  }
  return {
    ...facet,
    finding_total: facet.finding_total + findings.length,
    groups: [...groups]
      .map(([project, records]) => ({ finding_count: records.length, project, records }))
      .toSorted((a, b) => a.project.localeCompare(b.project)),
  };
}
