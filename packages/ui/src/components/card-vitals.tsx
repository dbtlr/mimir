import type { Distribution } from '@mimir/contract';

import { cardVitals } from '../lib/card-vitals';
import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';

/**
 * The project card's vitals panel (MMR-106) — a proportion bar over the active
 * states plus a five-count legend (review · in prog · ready · await · blocked),
 * from MMR-105's leaf-counts facet. Reuses the one status-color system; zero
 * counts recede so the live signals carry. Replaces the old single ready hero
 * and the full distribution bar.
 */
export function CardVitals({ counts }: { counts: Distribution | undefined }) {
  const vitals = cardVitals(counts);
  const active = vitals.filter((v) => v.count > 0);
  const title = active.map((v) => `${STATUS_META[v.word].label} ${String(v.count)}`).join(' · ');

  return (
    <div className="flex flex-col gap-2.5">
      {/* proportion bar over the active states only — the live work's shape */}
      {active.length > 0 ? (
        <div
          role="img"
          aria-label={title}
          title={title}
          className="flex h-1.5 gap-px overflow-hidden rounded-full"
        >
          {active.map((v) => (
            <span
              key={v.word}
              className={cn('h-full', STATUS_META[v.word].dot)}
              style={{ flexBasis: 0, flexGrow: v.count }}
            />
          ))}
        </div>
      ) : (
        <div className="h-1.5 rounded-full bg-line" />
      )}
      {/* five-count legend, fixed band-mirroring order; a 5-col grid so counts
          column-align and wrapping is predictable; zeros recede */}
      <ul className="grid grid-cols-5 gap-x-1.5">
        {vitals.map((v) => (
          <li
            key={v.word}
            className={cn(
              'flex items-center gap-1 text-3xs whitespace-nowrap text-ink-dim',
              v.count === 0 && 'opacity-45',
            )}
          >
            <span
              className={cn('h-[6px] w-[6px] shrink-0 rounded-full', STATUS_META[v.word].dot)}
            />
            <span className="font-mono font-bold text-ink-bright tabular-nums">{v.count}</span>
            <span className="truncate">{v.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
