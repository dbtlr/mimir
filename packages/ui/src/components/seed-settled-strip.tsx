import { useState } from 'react';

import type { WireSeed } from '../api/types';
import { settledCounts } from '../lib/seed-lanes';
import { SeedRow } from './seed-row';

/**
 * The SETTLED lane (MMR-247) — folded by default to a bottom strip
 * ("SETTLED · N · x resolved · y rejected ⌄"), expandable to the terminal rows
 * (read-only, dimmed). Counts split by lifecycle within the settled lane.
 */
export function SeedSettledStrip({
  seeds,
  activeId,
  onSelect,
}: {
  seeds: WireSeed[];
  activeId: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { resolved, rejected } = settledCounts(seeds);

  return (
    <section aria-label="Settled" className="mt-2 flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-2 rounded-lg border border-line bg-well-recessed px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="microlabel font-mono text-ink-ghost">Settled · {seeds.length}</span>
        <span className="text-tag text-ink-faint">
          {resolved} resolved · {rejected} rejected
        </span>
        <span aria-hidden className="ml-auto text-micro text-ink-ghost">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-2">
          {seeds.map((seed) => (
            <SeedRow
              key={seed.id}
              seed={seed}
              active={seed.id === activeId}
              onSelect={onSelect}
              dimmed
            />
          ))}
        </div>
      )}
    </section>
  );
}
