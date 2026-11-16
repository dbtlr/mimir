import type { DeliveryDetailView, DeliveryView } from '@mimir/contract';
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

export type DeliveryValue = { delivery: DeliveryShown; presentation: Presentation };
export const deliveryEchoViews = recordViews<DeliveryValue>({
  ids: (v) => v.delivery.id,
  json: (v) => v.delivery,
  records: (v) => renderDelivery(v.delivery, v.presentation),
});
