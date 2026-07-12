import type { Lane } from '@mimir/contract';
import { useState } from 'react';

import { cn } from '../lib/cn';
import type { LaneGroup } from '../lib/lanes';
import { ProjectCard } from './project-card';

/**
 * One Lane on the Overview (MMR-226): a mono microlabel keyed to the lane's hue
 * (`AWAITING YOU · 3`) trailed by a hairline rule that fades right, then the
 * project cards in a three-column grid. The `At rest` lane is `collapsible` — a
 * disclosure (re-collapsible, `aria-expanded`) that folds resting projects to a
 * recessed strip of mono key chips so they don't dominate, unfolding to the same
 * card grid the other lanes use.
 */

/** Per-lane header hue + fading rule alpha (the calm priority gradient). */
const LANE_STYLE: Record<Lane, { text: string; rule: string }> = {
  at_rest: { rule: 'from-line', text: 'text-ink-ghost' },
  awaiting_you: { rule: 'from-attention/18', text: 'text-attention' },
  live: { rule: 'from-status-in-progress/15', text: 'text-status-in-progress' },
  needs_unsticking: { rule: 'from-status-blocked/15', text: 'text-status-blocked' },
};

export function LaneSection({
  lane,
  onOpen,
  collapsible = false,
  droppedByKey,
}: {
  lane: LaneGroup;
  onOpen: (key: string) => void;
  collapsible?: boolean;
  /** Per-project record-damage counts (MMR-185) — the card's amber vital. */
  droppedByKey?: Map<string, number>;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = lane.projects.length;
  const style = LANE_STYLE[lane.lane];

  const cards = (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {lane.projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          onOpen={onOpen}
          lane={lane.lane}
          dropped={droppedByKey?.get(project.id)}
        />
      ))}
    </div>
  );

  // The At-rest lane folds to a recessed strip of key chips; the strip itself is
  // the disclosure, unfolding to the same card grid the live lanes use.
  if (collapsible) {
    return (
      <section aria-label={lane.label} className="flex flex-col gap-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((e) => !e);
          }}
          className="flex items-center gap-2.5 rounded-xl border border-line bg-well-recessed px-4 py-[11px] text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="font-mono text-micro font-semibold tracking-[0.13em] text-ink-ghost uppercase">
            {lane.label} · {count}
          </span>
          <span className="ml-2 flex flex-wrap items-center gap-2">
            {lane.projects.map((project) => (
              <span
                key={project.id}
                className="rounded-md border border-line px-2 py-[3px] font-mono text-mono-id text-cold"
              >
                {project.id}
              </span>
            ))}
          </span>
          <span className="ml-auto shrink-0 text-micro text-ink-ghost">
            {expanded ? '⌃ fold' : '⌄ unfold'}
          </span>
        </button>
        {expanded && cards}
      </section>
    );
  }

  return (
    <section aria-label={lane.label} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'shrink-0 font-mono text-micro font-semibold tracking-[0.13em] uppercase',
            style.text,
          )}
        >
          {lane.label} · {count}
        </span>
        <span className={cn('h-px flex-1 bg-gradient-to-r to-transparent', style.rule)} />
      </div>
      {cards}
    </section>
  );
}
