import { useState } from "react";
import type { AttentionBand } from "@mimir/contract";
import type { FleetBand } from "../lib/fleet-bands";
import { cn } from "../lib/cn";
import { STATUS_META } from "../lib/status";
import { FleetCard } from "./fleet-card";

/**
 * One attention-band on the fleet (MMR-102/106): a header keyed by a status-hue
 * pip + a rule that fades right (the calm priority gradient), then the project
 * cards. The `At rest` band is `collapsible` — a proper disclosure (re-collapsible,
 * `aria-expanded`) folding resting projects to a count strip so they don't
 * dominate, the fleet equivalent of the board's done-windowing (ADR 0013 §4).
 */

/** The status hue that keys each band's header pip — the priority gradient. */
const BAND_PIP: Record<AttentionBand, string> = {
  awaiting_you: STATUS_META.under_review.dot,
  live: STATUS_META.in_progress.dot,
  needs_unsticking: STATUS_META.blocked.dot,
  at_rest: STATUS_META.abandoned.dot,
};

export function BandSection({
  band,
  onOpen,
  collapsible = false,
}: {
  band: FleetBand;
  onOpen: (key: string) => void;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = band.projects.length;

  const cards = (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {band.projects.map((project) => (
        <FleetCard key={project.id} project={project} onOpen={onOpen} />
      ))}
    </div>
  );

  return (
    <section aria-label={band.label} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <span className={cn("h-[3px] w-5 shrink-0 rounded-sm", BAND_PIP[band.band])} />
        <h2 className="microlabel text-ink">{band.label}</h2>
        <span className="rounded-full border border-line px-2 py-px font-mono text-[0.6875rem] text-ink-dim tabular-nums">
          {count}
        </span>
        <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
      </div>
      {collapsible ? (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((e) => !e);
            }}
            className="flex w-full items-center gap-2 rounded-md border border-line bg-well-900/50 px-3 py-2.5 text-left text-[0.75rem] text-ink-dim transition-colors hover:border-line-bright hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="font-mono text-ink tabular-nums">{count}</span>{" "}
            {band.label.toLowerCase()}
            <span className="ml-auto text-ink-faint">{expanded ? "hide ↑" : "view all →"}</span>
          </button>
          {expanded && cards}
        </>
      ) : (
        cards
      )}
    </section>
  );
}
