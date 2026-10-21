import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { useUnpairDevice } from '../api/device-mutations';
import { pairedDevicesQuery, pendingPairingsQuery } from '../api/device-queries';
import type { PairedDevice } from '../api/fns/devices';
import { OfflineBanner } from '../components/offline-banner';
import { actionButtonVariants, ActionButton } from '../components/ui/action-button';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { absoluteTime, ago, calendarDate, until } from '../lib/time';

/**
 * `/devices` — the clients that wait to pair with this host and the ones
 * paired with it (ADR 0038, MMR-585). Waiting requests are read-only here: a
 * request's code is stored hashed, so the operator decides on `/pair` with the
 * code the device shows. Unpairing asks first, in the row, because the device
 * loses access the moment it is confirmed.
 */

/** A titled card holding a list or its empty line. */
function ListCard({
  title,
  empty,
  rows,
  pending,
}: {
  title: string;
  empty: string;
  rows: ReactNode[];
  pending: boolean;
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-xl border border-line bg-well-850"
    >
      <h2 className="microlabel border-b border-line bg-well-950 px-4 py-2.5 text-ink-faint">
        {title}
      </h2>
      {pending && <Skeleton className="m-3 h-10" />}
      {!pending && rows.length === 0 && <p className="px-4 py-4 text-xs text-ink-dim">{empty}</p>}
      {rows.length > 0 && <ul className="divide-y divide-line">{rows}</ul>}
    </section>
  );
}

const ROW = 'flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-meta';

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={cn('size-[7px] shrink-0 rounded-full', className)} />;
}

/** A paired device, with Unpair turning into an inline confirm. */
function PairedRow({ device }: { device: PairedDevice }) {
  const [confirming, setConfirming] = useState(false);
  const unpair = useUnpairDevice();
  return (
    <li className={ROW}>
      <Dot className={device.last_used_at === null ? 'bg-ink-ghost' : 'bg-status-done'} />
      <span className="min-w-0 truncate font-mono text-ink-bright">{device.device}</span>
      <span className="text-ink-dim" title={absoluteTime(device.created_at)}>
        paired {calendarDate(device.created_at)} ·{' '}
        {device.last_used_at === null ? 'never used' : `used ${ago(device.last_used_at)}`}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {confirming ? (
          <>
            <span className="text-xs text-ink-dim">Its token stops working now.</span>
            <ActionButton
              size="sm"
              variant="outline"
              className="text-status-blocked-foreground inset-ring-status-blocked/35 hover:text-status-blocked-foreground"
              disabled={unpair.isPending}
              onClick={() => {
                unpair.mutate(device.device, {
                  onSettled: () => {
                    setConfirming(false);
                  },
                });
              }}
            >
              Unpair {device.device}
            </ActionButton>
            <ActionButton
              size="sm"
              variant="outline"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </ActionButton>
          </>
        ) : (
          <ActionButton
            size="sm"
            className="text-ink-dim hover:text-ink-bright"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Unpair
          </ActionButton>
        )}
      </div>
    </li>
  );
}

export function DevicesPage() {
  const pending = useQuery(pendingPairingsQuery);
  const paired = useQuery(pairedDevicesQuery);
  const conn = connectivity([pending, paired]);

  return (
    <>
      <OfflineBanner {...conn} />
      <main className="mx-auto flex w-full max-w-[960px] min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">Devices</h1>
          <span className="font-mono text-[11.5px] text-ink-faint">
            clients paired with this host
          </span>
          <Link to="/pair" className={cn(actionButtonVariants({ variant: 'outline' }), 'ml-auto')}>
            Enter a code
          </Link>
        </div>

        <ListCard
          title="Waiting"
          empty="No devices are waiting."
          pending={pending.isPending}
          rows={(pending.data ?? []).map((request) => (
            <li key={request.device} className={ROW}>
              <Dot className="bg-attention" />
              <span className="min-w-0 truncate font-mono text-ink-bright">{request.device}</span>
              <span className="text-ink-dim">filed {ago(request.created_at)}</span>
              <span className="text-ink-dim">expires {until(request.expires_at)}</span>
            </li>
          ))}
        />

        <ListCard
          title="Paired"
          empty="No devices are paired."
          pending={paired.isPending}
          rows={(paired.data ?? []).map((device) => (
            <PairedRow key={device.device} device={device} />
          ))}
        />
      </main>
    </>
  );
}
