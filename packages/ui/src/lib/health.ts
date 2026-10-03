import type { WireDoctorFacet } from '../api/types';

/**
 * Per-project finding count from the (unscoped) record-health facet (MMR-185) —
 * the lookup the always-on surfacing reads: the Overview card vital, the attention
 * health line, and (via its own scoped fetch) the project-header chip. A project
 * with no findings is absent, so a plain `.get(key)` distinguishes "healthy".
 */
export function findingsByProject(facet: WireDoctorFacet | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const group of facet?.groups ?? []) {
    if (group.finding_count > 0) {
      out.set(group.project, group.finding_count);
    }
  }
  return out;
}

/** `1 finding` / `N findings` — the count phrase every health surface shows. */
export function findingCount(n: number): string {
  return `${String(n)} ${n === 1 ? 'finding' : 'findings'}`;
}
