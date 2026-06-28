import { useState } from "react";
import type { FleetBand } from "../lib/fleet-bands";
import { FleetCard } from "./fleet-card";

/**
 * One attention-band on the fleet (MMR-102): a labelled header with its project
 * count, then the project cards (recency-desc). The `At rest` band is
 * `collapsible` — folded to an expandable count strip by default, the fleet
 * equivalent of the board's done-windowing (ADR 0013 §4), so resting projects
 * don't dominate the page. Placeholder visuals — the design pass refines them.
 */
export function BandSection({
  band,
  readyByKey,
  onOpen,
  collapsible = false,
}: {
  band: FleetBand;
  readyByKey: Map<string, number>;
  onOpen: (key: string) => void;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = band.projects.length;
  const showCards = !collapsible || expanded;

  return (
    <section aria-label={band.label} className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="microlabel text-ink-faint">{band.label}</h2>
        <span className="font-mono text-[0.625rem] text-ink-dim tabular-nums">{count}</span>
      </div>
      {showCards ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {band.projects.map((project) => (
            <FleetCard
              key={project.id}
              project={project}
              ready={readyByKey.get(project.id) ?? 0}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
          }}
          aria-label={`Expand ${band.label} (${String(count)})`}
          className="rounded-md border border-line bg-well-900/40 px-3 py-2 text-left text-[0.75rem] text-ink-dim transition-colors hover:border-line-bright hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
        >
          {count} {band.label.toLowerCase()} · view all →
        </button>
      )}
    </section>
  );
}
