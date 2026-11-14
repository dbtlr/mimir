import type { DeliveryView } from '@mimir/contract';
/** A delivery's complete record, with history only when requested. */
export function renderDelivery(delivery: DeliveryView): string {
  const { history, ...fields } = delivery;
  return (
    Object.entries(fields)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join('\n') +
    (history.length
      ? `\nHistory\n${history.map((entry) => `${entry.at} ${entry.kind}: ${entry.from_value ?? '—'} → ${entry.to_value ?? '—'}${entry.task === null ? '' : ` ${entry.task}`}${entry.reason === null ? '' : ` — ${entry.reason}`}`).join('\n')}`
      : '')
  );
}
