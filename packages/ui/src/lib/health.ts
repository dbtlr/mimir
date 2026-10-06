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

/** The group key store-level findings carry (config, schema); no project key can be it. */
const STORE_GROUP = 'store';

/** The Record-health panel search that shows a group's findings: its project
 * scope, or the unscoped panel for the store group, since a project scope
 * excludes every store-level finding. */
export function healthSearch(group: string): { project?: string } {
  return group === STORE_GROUP ? {} : { project: group };
}
