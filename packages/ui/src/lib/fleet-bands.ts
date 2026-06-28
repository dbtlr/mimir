import type { AttentionBand } from "@mimir/contract";
import type { WireNode } from "../api/types";

/**
 * The fleet's attention-band grouping (MMR-102) — `mimir next` lifted to the
 * project level. A pure transform from the projects list (each carrying
 * MMR-101's `attention` facet) into ordered, non-empty bands, recency-sorted
 * within each. When the facet is absent (offline / pre-feature cache) it
 * degrades to a flat list in the server's given order — attention is an
 * overlay, like the ready count, so a miss costs the ordering, not the fleet.
 */

/** A non-empty band: its key, its display label, and its projects (recency-desc). */
export interface FleetBand {
  band: AttentionBand;
  label: string;
  projects: WireNode[];
}

/** Banded when every project carries the facet; flat (input order) otherwise. */
export type FleetGrouping =
  | { mode: "banded"; bands: FleetBand[] }
  | { mode: "flat"; projects: WireNode[] };

/** The bands in fixed highest-wins order (MMR-101) with their display labels. */
const BAND_ORDER: readonly { band: AttentionBand; label: string }[] = [
  { band: "awaiting_you", label: "Awaiting you" },
  { band: "live", label: "Live" },
  { band: "needs_unsticking", label: "Needs unsticking" },
  { band: "at_rest", label: "At rest" },
];

export function groupIntoBands(projects: WireNode[]): FleetGrouping {
  // A single project without the facet means a degraded payload — fall back flat.
  if (projects.some((p) => p.attention === undefined)) {
    return { mode: "flat", projects };
  }
  const bands: FleetBand[] = [];
  for (const { band, label } of BAND_ORDER) {
    const members = projects
      .filter((p) => p.attention?.band === band)
      .sort(
        (a, b) =>
          Date.parse(b.attention?.last_activity ?? "") -
          Date.parse(a.attention?.last_activity ?? ""),
      );
    if (members.length > 0) {
      bands.push({ band, label, projects: members });
    }
  }
  return { mode: "banded", bands };
}
