import type { DeliveryDetailView, DeliverySinceView, DeliveryView } from '@mimir/contract';
import { formatInstant } from '@mimir/helpers';

import { hangingIndent } from './node';
import { arrow } from './presentation';
import type { Presentation } from './presentation';
import { recordViews } from './views';

/** A delivery as a verb echoes it (no lists) or `get` reads it (with them). */
export type DeliveryShown = DeliveryView &
  Partial<Pick<DeliveryDetailView, 'declined' | 'journal' | 'limitations'>>;

/** The `journal` line: the live pad's UUID, then the frozen journals' ids; null when it has neither. */
function journalLine(journal: DeliveryDetailView['journal']): string | null {
  const parts = [
    ...(journal.scratchpad === null ? [] : [`scratchpad ${journal.scratchpad}`]),
    ...(journal.artifacts.length === 0 ? [] : [`frozen ${journal.artifacts.join(', ')}`]),
  ];
  return parts.length === 0 ? null : `journal: ${parts.join('; ')}`;
}

/**
 * A delivery's complete record and its history; plain output keeps to ASCII glyphs.
 * A multi-line value or reason hangs under where it began, as a task record's does.
 * A read that carries the lists prints each non-empty one a line per entry, then
 * the `journal` line when it has a pad or a frozen journal (ADR 0042, MMR-691).
 */
export function renderDelivery(delivery: DeliveryShown, p: Presentation): string {
  const { history, limitations = [], declined = [], journal, ...fields } = delivery;
  const dash = p.plain ? '-' : '—';
  const line = (entry: DeliveryView['history'][number]): string => {
    const task = entry.task === null ? '' : ` ${entry.task}`;
    const head = `${formatInstant(entry.at, p.zone)} ${entry.kind}: ${entry.from_value ?? dash} ${arrow(p.plain)} ${entry.to_value ?? dash}${task}`;
    return entry.reason === null ? head : hangingIndent(`${head} ${dash} `, entry.reason);
  };
  const entry = (number: number, at: string, text: string): string =>
    hangingIndent(`${String(number)}. `, `${formatInstant(at, p.zone)} ${dash} ${text}`);
  const journalText = journal === undefined ? null : journalLine(journal);
  return [
    Object.entries(fields)
      .filter(([, v]) => v !== null)
      // Instants read in the caller's zone (ADR 0029); structured output keeps ISO.
      .map(([k, v]) =>
        hangingIndent(`${k}: `, k.endsWith('_at') ? formatInstant(String(v), p.zone) : String(v)),
      )
      .join('\n'),
    ...(journalText === null ? [] : [journalText]),
    ...(limitations.length
      ? [`Limitations\n${limitations.map((e) => entry(e.number, e.created_at, e.text)).join('\n')}`]
      : []),
    ...(declined.length
      ? [
          `Declined\n${declined
            .map((e) => entry(e.number, e.created_at, `${e.finding} (${e.reason})`))
            .join('\n')}`,
        ]
      : []),
    ...(history.length ? [`History\n${history.map(line).join('\n')}`] : []),
  ].join('\n');
}

/** The change feed of a since read: its cursors and its events. */
export type DeliveryFeed = Pick<DeliverySinceView, 'as_of' | 'events' | 'since'>;

/**
 * One event of a since read: its time, the record it happened on, its kind, and
 * the fields it carries. A continuation line hangs under the first.
 */
function eventLine(event: DeliveryFeed['events'][number], p: Presentation): string {
  const dash = p.plain ? '-' : '—';
  const move =
    event.from === null && event.to === null
      ? null
      : `${event.from ?? dash} ${arrow(p.plain)} ${event.to ?? dash}`;
  const detail = [move, event.task, event.text].filter((part) => part !== null).join(' ');
  const number = event.number === null ? '' : ` #${String(event.number)}`;
  const head = `${formatInstant(event.at, p.zone)} ${event.record} ${event.kind}${number}`;
  const line = `${head}${detail === '' ? '' : `: ${detail}`}${event.reason === null ? '' : ` ${dash} ${event.reason}`}`;
  return line.replaceAll('\n', '\n  ');
}

/**
 * A since read in records: the delivery as `get` prints it, a `since` line that
 * gives both cursors as the instants to pass back, then one line per event.
 */
export function renderDeliverySince(
  delivery: DeliveryShown,
  feed: DeliveryFeed,
  p: Presentation,
): string {
  return [
    renderDelivery(delivery, p),
    `since: ${feed.since} as_of: ${feed.as_of}`,
    ...feed.events.map((event) => eventLine(event, p)),
  ].join('\n');
}

export type DeliveryValue = { delivery: DeliveryShown; presentation: Presentation };
export const deliveryEchoViews = recordViews<DeliveryValue>({
  ids: (v) => v.delivery.id,
  json: (v) => v.delivery,
  records: (v) => renderDelivery(v.delivery, v.presentation),
});
