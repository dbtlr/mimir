import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { cardVariants } from '../../ui/card';

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

/** A number to `digits` places, without a trailing `.0`. */
function trim(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/u, '');
}

/** A count in full, with thousands separators. */
function exact(count: number): string {
  return count.toLocaleString('en-US');
}

/**
 * A count as the chart shows it, four characters at most so it stays inside
 * its column on a 320px phone: exact up to 999, then 1.2k, 12k, and 1.2M.
 */
export function shortCount(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 9950) {
    return `${trim(count / 1000, 1)}k`;
  }
  // Rounding can carry into the next unit (999,600 → 1000k), so M starts where
  // the rounded k value would reach 1000.
  if (count < 999_500) {
    return `${trim(count / 1000, 0)}k`;
  }
  const millions = count / 1_000_000;
  return `${trim(millions, millions < 9.95 ? 1 : 0)}M`;
}

/** The sentence a screen reader hears for the chart, with every exact count. */
export function chartName(days: readonly ShippedDay[]): string {
  const today = days.at(-1);
  if (today === undefined) {
    return 'Nothing shipped to show.';
  }
  const past = days.slice(0, -1).map((day) => `${day.name} ${exact(day.count)}`);
  const sofar = `${exact(today.count)} so far ${today.name}`;
  const span = days.length === 1 ? 'today' : `each day for the last ${String(days.length)} days`;
  return past.length === 0
    ? `Shipped ${span}: ${sofar}.`
    : `Shipped ${span}: ${past.join(', ')}, and ${sofar}.`;
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
    <div className={cn(cardVariants(), 'px-4 pt-3.5', breakdown === undefined && 'pb-3.5')}>
      <div role="img" aria-label={chartName(days)} className="flex max-w-[520px] gap-2">
        {days.map((day, index) => {
          const today = index === days.length - 1;
          // A partial day keeps 4px so its outline still frames a fill.
          const floor = today ? 4 : 2;
          const height =
            day.count === 0 ? 0 : Math.max(floor, Math.round((day.count / max) * PLOT));
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
