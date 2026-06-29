import type { AttentionBand } from '@mimir/contract';
import { useState } from 'react';

import type { BandGroup } from '../lib/attention-bands';
import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';
import { ProjectCard } from './project-card';

/**
 * One attention-band on the overview (MMR-102/106): a header keyed by a status-hue
 * pip + a rule that fades right (the calm priority gradient), then the project
 * cards. The `At rest` band is `collapsible` — a proper disclosure (re-collapsible,
 * `aria-expanded`) folding resting projects to a count strip so they don't
 * dominate, the overview equivalent of the board's done-windowing (ADR 0013 §4).
 */

/** The status hue that keys each band's header pip — the priority gradient. */
const BAND_PIP: Record<AttentionBand, string> = {
  at_rest: STATUS_META.abandoned.dot,
  awaiting_you: STATUS_META.under_review.dot,
  live: STATUS_META.in_progress.dot,
  needs_unsticking: STATUS_META.blocked.dot,
};

export function BandSection({
  band,
  onOpen,
  collapsible = false,
}: {
  band: BandGroup;
  onOpen: (key: string) => void;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = band.projects.length;

  const cards = (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {band.projects.map((project) => (
        <ProjectCard key={project.id} project={project} onOpen={onOpen} />
      ))}
    </div>
  );

  const pip = <span className={cn('h-[3px] w-5 shrink-0 rounded-sm', BAND_PIP[band.band])} />;
  const label = <h2 className="microlabel text-ink">{band.label}</h2>;
  const countChip = (
    <span className="rounded-full border border-line px-2 py-px font-mono text-2xs text-ink-dim tabular-nums">
      {count}
    </span>
  );
  const rule = <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />;

  // The At-rest band folds its projects away by default — the header itself is
  // the disclosure (no separate repeating strip), keeping the band-header idiom.
  if (collapsible) {
    return (
      <section aria-label={band.label} className="flex flex-col gap-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((e) => !e);
          }}
          className="group flex items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          {pip}
          {label}
          {countChip}
          {rule}
          <span className="text-2xs text-ink-faint transition-colors group-hover:text-ink">
            {expanded ? 'Hide ↑' : 'Show ↓'}
          </span>
        </button>
        {expanded && cards}
      </section>
    );
  }

  return (
    <section aria-label={band.label} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        {pip}
        {label}
        {countChip}
        {rule}
      </div>
      {cards}
    </section>
  );
}
