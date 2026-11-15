import type { DeliveryView } from '@mimir/contract';

import { hangingIndent } from './node';
import { arrow } from './presentation';
import type { Presentation } from './presentation';
import { recordViews } from './views';

/** A delivery's complete record and its history; plain output keeps to ASCII glyphs.
 * A multi-line value or reason hangs under where it began, as a task record's does. */
export function renderDelivery(delivery: DeliveryView, p: Presentation): string {
  const { history, ...fields } = delivery;
  const dash = p.plain ? '-' : '—';
  const line = (entry: DeliveryView['history'][number]): string => {
    const task = entry.task === null ? '' : ` ${entry.task}`;
    const head = `${entry.at} ${entry.kind}: ${entry.from_value ?? dash} ${arrow(p.plain)} ${entry.to_value ?? dash}${task}`;
    return entry.reason === null ? head : hangingIndent(`${head} ${dash} `, entry.reason);
  };
  return (
    Object.entries(fields)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => hangingIndent(`${k}: `, String(v)))
      .join('\n') + (history.length ? `\nHistory\n${history.map(line).join('\n')}` : '')
  );
}

export type DeliveryValue = { delivery: DeliveryView; presentation: Presentation };
export const deliveryEchoViews = recordViews<DeliveryValue>({
  ids: (v) => v.delivery.id,
  json: (v) => v.delivery,
  records: (v) => renderDelivery(v.delivery, v.presentation),
});
