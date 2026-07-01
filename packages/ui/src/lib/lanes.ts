import type { Lane } from '@mimir/contract';

import type { WireNode } from '../api/types';

/**
 * The overview's Lane grouping (MMR-102) — `mimir next` lifted to the project
 * level. A pure transform from the projects list (each carrying MMR-101's
 * `attention` facet) into ordered, non-empty lanes, recency-sorted within each.
 * When the facet is absent (offline / pre-feature cache) it degrades to a flat
 * list in the server's given order — the lane is an overlay, like the ready
 * count, so a miss costs the ordering, not the overview.
 */

/** A non-empty lane: its key, its display label, and its projects (recency-desc). */
export type LaneGroup = {
  lane: Lane;
  label: string;
  projects: WireNode[];
};

/** Grouped when every project carries the facet; flat (input order) otherwise. */
export type LaneGrouping =
  | { mode: 'grouped'; lanes: LaneGroup[] }
  | { mode: 'flat'; projects: WireNode[] };

/** The lanes in fixed highest-wins order (MMR-101) with their display labels. */
const LANE_ORDER: readonly { lane: Lane; label: string }[] = [
  { label: 'Awaiting you', lane: 'awaiting_you' },
  { label: 'Live', lane: 'live' },
  { label: 'Needs unsticking', lane: 'needs_unsticking' },
  { label: 'At rest', lane: 'at_rest' },
];

export function groupIntoLanes(projects: WireNode[]): LaneGrouping {
  // A single project without the facet means a degraded payload — fall back flat.
  if (projects.some((p) => p.attention === undefined)) {
    return { mode: 'flat', projects };
  }
  const lanes: LaneGroup[] = [];
  for (const { lane, label } of LANE_ORDER) {
    const members = projects
      .filter((p) => p.attention?.lane === lane)
      .toSorted(
        (a, b) =>
          Date.parse(b.attention?.last_activity ?? '') -
          Date.parse(a.attention?.last_activity ?? ''),
      );
    if (members.length > 0) {
      lanes.push({ label, lane, projects: members });
    }
  }
  return { lanes, mode: 'grouped' };
}
