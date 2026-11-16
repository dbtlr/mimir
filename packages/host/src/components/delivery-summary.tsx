import type { Distribution, EngineDelivery, EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { phaseDeliveriesQuery } from '../api/view-queries';
import { deliveryLink } from '../lib/record-url';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { DistributionBar } from './distribution-bar';

/** Members use the same closed task status vocabulary as every work row. */
export function memberDistribution(members: EngineNode[]): Distribution {
  const result: Distribution = {};
  for (const member of members) {
    result[member.status] = (result[member.status] ?? 0) + 1;
  }
  return result;
}
export function DeliveryWords({ delivery }: { delivery: EngineDelivery }) {
  return (
    <span className="inline-flex gap-1.5 text-tag text-ink">
      <span className="rounded border border-line px-2 py-0.5">{delivery.lifecycle}</span>
      {delivery.hold !== 'none' && (
        <span className="rounded border border-line px-2 py-0.5">{delivery.hold}</span>
      )}
    </span>
  );
}
export function DeliveryTime({ delivery }: { delivery: EngineDelivery }) {
  const elapsed = Math.floor(delivery.elapsed_minutes ?? 0);
  const cap = delivery.time_cap_minutes;
  return (
    <div className="flex flex-col gap-1 text-tag text-ink-dim">
      <span>
        {elapsed} min elapsed{cap !== null && ` / ${String(cap)} min cap`}
      </span>
      {cap !== null && (
        <div
          role="progressbar"
          aria-label="Delivery time"
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={Math.min(elapsed, cap)}
          className="h-1 overflow-hidden rounded bg-well-800"
        >
          <div
            className="h-full bg-ink-dim"
            style={{ width: `${String(Math.min(100, (elapsed / cap) * 100))}%` }}
          />
        </div>
      )}
    </div>
  );
}
/** Live attempts are cards, with the same member distribution as their dossier. */
export function PhaseDeliveries({ id }: { id: string }) {
  const query = useQuery(phaseDeliveriesQuery(id));
  if (query.isError) {
    return <p className="text-xs text-ink-dim">Couldn’t load deliveries.</p>;
  }
  if (!query.data?.length) {
    return null;
  }
  return (
    <section aria-label="Live deliveries" className="flex flex-col gap-2">
      <h2 className="microlabel text-ink-faint">Live deliveries</h2>
      {query.data.map(({ delivery, members }) => (
        <Link
          key={delivery.id}
          {...deliveryLink(delivery.id)}
          className={`flex flex-col gap-2 rounded-lg border border-line bg-well-950 p-3 ${PHONE_TOUCH_TARGET}`}
        >
          <span className="font-mono text-mono-id text-ink-faint">{delivery.id}</span>
          <strong className="text-meta text-ink-bright">{delivery.title}</strong>
          <DeliveryWords delivery={delivery} />
          <DeliveryTime delivery={delivery} />
          <DistributionBar distribution={memberDistribution(members)} />
        </Link>
      ))}
    </section>
  );
}
