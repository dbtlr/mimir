import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';

/** One day of the chart: its count, its full name for the accessible name, and its short label. */
export type ShippedDay = {
  count: number;
  /** "Monday", or "today" for the last day. */
  name: string;
  /** "Mon", or "Today". */
  short: string;
};

/** The chart's plot height in px; the tallest bar fills it. */
const PLOT = 84;

/** A count as the chart shows it: exact up to 9,999, shortened past it (12.4k). */
export function shortCount(count: number): string {
  if (count <= 9999) {
    return count.toLocaleString('en-US');
  }
  return `${(count / 1000).toFixed(1).replace(/\.0$/u, '')}k`;
}

/** The sentence a screen reader hears for the chart, with every exact count. */
export function chartName(days: readonly ShippedDay[]): string {
  const past = days.slice(0, -1).map((day) => `${day.name} ${day.count.toLocaleString('en-US')}`);
  const today = days.at(-1);
  const last =
    today === undefined ? '' : `, and ${today.count.toLocaleString('en-US')} so far ${today.name}`;
  return `Shipped each day for the last ${String(days.length)} days: ${past.join(', ')}${last}.`;
}

/**
 * The Shipped summary (ADR 0019, MMR-719 refinement): a seven-day column chart,
 * oldest to today, then `breakdown`, a row group of counts one level down. The
 * last day is today and partial, so its bar is outlined over a weaker fill and
 * labelled "so far". Every column reserves the same count and label rows, so
 * all bars share one baseline.
 */
export function ShippedSummary({
  days,
  breakdown,
}: {
  /** Oldest first; the last day is today. */
  days: readonly ShippedDay[];
  breakdown?: ReactNode;
}) {
  const max = Math.max(1, ...days.map((day) => day.count));
  return (
    <div className="rounded-[10px] border border-line bg-well-850 px-4 pt-3.5 light:shadow-card">
      <div role="img" aria-label={chartName(days)} className="flex max-w-[520px] gap-2">
        {days.map((day, index) => {
          const today = index === days.length - 1;
          const height = day.count === 0 ? 0 : Math.max(2, Math.round((day.count / max) * PLOT));
          return (
            <div
              key={day.short}
              aria-hidden="true"
              className="grid min-w-0 flex-1 grid-rows-[16px_84px_32px] justify-items-center gap-y-1"
            >
              <span
                className={cn(
                  'self-end text-xs whitespace-nowrap',
                  today ? 'font-semibold text-ink-bright' : 'text-ink-dim',
                )}
              >
                {shortCount(day.count)}
              </span>
              <span className="flex w-full max-w-11 items-end">
                <span
                  className={cn(
                    'block w-full shrink-0 rounded-t-[3px]',
                    today
                      ? 'bg-[color-mix(in_srgb,var(--color-status-done)_45%,var(--color-well-850))] inset-ring inset-ring-status-done'
                      : 'bg-status-done',
                  )}
                  style={{ height }}
                />
              </span>
              <span
                className={cn(
                  'text-center text-xs',
                  today ? 'font-semibold text-ink-bright' : 'text-ink-dim',
                )}
              >
                {day.short}
                {today && <span className="block">so far</span>}
              </span>
            </div>
          );
        })}
      </div>
      {breakdown !== undefined && <div className="mt-3 border-t border-line">{breakdown}</div>}
    </div>
  );
}
