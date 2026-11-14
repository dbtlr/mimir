import type { DeliveryView } from '@mimir/contract';

import { arrow } from './presentation';
import type { Presentation } from './presentation';

/** A delivery's complete record, with history only when requested; plain output keeps to ASCII glyphs. */
export function renderDelivery(delivery: DeliveryView, p: Presentation): string {
  const { history, ...fields } = delivery;
  const dash = p.plain ? '-' : '—';
  const line = (entry: DeliveryView['history'][number]): string =>
    `${entry.at} ${entry.kind}: ${entry.from_value ?? dash} ${arrow(p.plain)} ${entry.to_value ?? dash}` +
    `${entry.task === null ? '' : ` ${entry.task}`}${entry.reason === null ? '' : ` ${dash} ${entry.reason}`}`;
  return (
    Object.entries(fields)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join('\n') + (history.length ? `\nHistory\n${history.map(line).join('\n')}` : '')
  );
}
