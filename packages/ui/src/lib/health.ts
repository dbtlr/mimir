import type { WireDoctorFacet } from '../api/types';

/**
 * Per-project dropped count from the (unscoped) record-health facet (MMR-185) —
 * the lookup the always-on surfacing reads: the Overview card vital, the attention
 * damage line, and (via its own scoped fetch) the project-header chip. A project
 * with zero drops is absent, so a plain `.get(key)` distinguishes "no damage".
 */
export function droppedByProject(facet: WireDoctorFacet | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const group of facet?.groups ?? []) {
    if (group.dropped > 0) {
      out.set(group.project, group.dropped);
    }
  }
  return out;
}

/** A byte offset with space-grouped thousands — the panel's `byte 18 240` idiom. */
export function groupBytes(byte: number): string {
  return byte.toLocaleString('en-US').replaceAll(',', ' ');
}
