/*
 * The host's record-health facet as the console reads it: a host concern, not
 * an Engine method (ADR 0034), so its shapes live here rather than in the
 * Engine contract. The host builds the facet from `mimir doctor` findings and
 * serves it through the `doctor` server function.
 */

/** One `mimir doctor` finding (MMR-185) — its cause chip, the row's
 * `<table>/<key>` locator, the offending column and value when the finding
 * names one, and the finding's structured evidence. */
export type WireDoctorRecord = {
  id: string;
  cause: string;
  severity: 'error' | 'warn';
  locator: string;
  field: string | null;
  value: string | null;
  evidence: Record<string, unknown>;
  note: string;
};

/** One project's findings. */
export type WireDoctorGroup = {
  project: string;
  finding_count: number;
  records: WireDoctorRecord[];
};

/** The record-health facet (MMR-185): `mimir doctor` findings grouped by
 * project, with the scan time the panel derives "last scan Ns ago" from.
 * `scope` is null on an unscoped scan; a scoped one reports how many records the
 * project holds, so an unknown key (zero) never reads as a clean board. */
export type WireDoctorFacet = {
  scanned_at: string;
  finding_total: number;
  groups: WireDoctorGroup[];
  scope: { key: string; matched_records: number } | null;
};
