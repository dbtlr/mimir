import type { Distribution, EngineDelivery, EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { t3OriginQuery } from '../api/t3-queries';
import { phaseDeliveriesQuery } from '../api/view-queries';
import { deliveryLink } from '../lib/record-url';
import { t3ThreadLink } from '../lib/t3-link';
import { absoluteTime } from '../lib/time';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { DistributionBar } from './distribution-bar';
import { ExternalRef } from './node-record';
import { OpenInT3 } from './open-in-t3';
import { RailSection } from './record-layout';

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
/** A delivery that has not started has no elapsed time (null), so it reads "Not started". */
export function DeliveryTime({ delivery }: { delivery: EngineDelivery }) {
  if (delivery.elapsed_minutes === null) {
    return <span className="text-meta text-ink-dim">Not started</span>;
  }
  const elapsed = Math.floor(delivery.elapsed_minutes);
  const cap = delivery.time_cap_minutes;
  return (
    <div className="flex flex-col gap-1 text-meta text-ink-dim">
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
/**
 * The delivery's facts: branch, pull request, T3 thread, and start. A fact
 * with no value reads "None". One component serves the phone's last section
 * and the top of the desktop rail.
 */
export function DeliveryFacts({ delivery: d }: { delivery: EngineDelivery }) {
  const origin = useQuery(t3OriginQuery).data?.origin ?? null;
  const hasThread = t3ThreadLink(origin, d) !== null;
  const startedAt =
    d.history.find((h) => h.kind === 'lifecycle' && h.to_value === 'running')?.at ?? d.created_at;
  return (
    <RailSection label="Facts">
      <dl className="flex flex-col gap-2 text-xs text-ink-dim">
        <dt>Branch</dt>
        <dd className="font-mono break-all">{d.branch ?? 'None'}</dd>
        <dt>Pull request</dt>
        <dd className="wrap-anywhere">
          {d.external_ref ? <ExternalRef value={d.external_ref} /> : 'None'}
        </dd>
        <dt>Thread</dt>
        <dd>
          {hasThread ? <OpenInT3 harness={d.harness} host={d.host} session={d.session} /> : 'None'}
        </dd>
        <dt>Start</dt>
        <dd>{d.elapsed_minutes === null ? 'Not started' : absoluteTime(startedAt)}</dd>
      </dl>
    </RailSection>
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
    <section aria-label="Live deliveries" className="mt-4 flex flex-col gap-2">
      <h2 className="microlabel text-ink-dim">Live deliveries</h2>
      {query.data.map(({ delivery, members }) => (
        <Link
          key={delivery.id}
          {...deliveryLink(delivery.id)}
          className={`flex flex-col gap-2 rounded-lg border border-line bg-well-950 p-3 wrap-anywhere ${PHONE_TOUCH_TARGET}`}
        >
          <span className="font-mono text-mono-id text-ink-dim">{delivery.id}</span>
          <strong className="text-title font-medium text-ink-bright">{delivery.title}</strong>
          <DeliveryWords delivery={delivery} />
          <DeliveryTime delivery={delivery} />
          <DistributionBar distribution={memberDistribution(members)} />
        </Link>
      ))}
    </section>
  );
}
