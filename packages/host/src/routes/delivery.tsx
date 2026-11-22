import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  useDeliveryUnblock,
  useDeliveryPark,
  useDeliveryUnpark,
  useDeliveryAbandon,
} from '../api/delivery-mutations';
import { isNotFound } from '../api/errors';
import { deliveryPageQuery } from '../api/view-queries';
import { BrowserGroup, BrowserRow } from '../components/browser-list';
import { DecisionActions } from '../components/decision-actions';
import { DecisionsEntry, entryLabel } from '../components/decisions-entry';
import { DeliveryDecisions } from '../components/decisions-walkthrough';
import {
  DeliveryFacts,
  DeliveryTime,
  DeliveryWords,
  memberDistribution,
} from '../components/delivery-summary';
import { DistributionBar } from '../components/distribution-bar';
import { OfflineBanner } from '../components/offline-banner';
import { Reason } from '../components/patterns/reason';
import { RailSection, RecordLayout, RecordPending } from '../components/record-layout';
import { StatusDot } from '../components/status-dot';
import { ActionButton } from '../components/ui/action-button';
import { DecisionRow } from '../components/work-rows';
import { Empty, NowRow } from '../components/work-sections';
import { connectivity } from '../lib/connectivity';
import { deliveryIdOf, artifactLink, seedLink, nodeLink } from '../lib/record-url';
import { STATUS_META, STATUS_ORDER } from '../lib/status';
import { absoluteTime } from '../lib/time';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { useRowFocusHandoff } from '../lib/use-row-focus-handoff';
import { deliveryRoute } from '../router';
import { NotFoundPage } from './not-found';

/** The delivery dossier and the operator’s legal lifecycle controls. */
export function DeliveryPage() {
  const { key, seq } = deliveryRoute.useParams();
  const id = deliveryIdOf(key, seq);
  return id === undefined ? (
    <NotFoundPage projectKey={key}>No delivery at this address.</NotFoundPage>
  ) : (
    <DeliveryRecord id={id} />
  );
}
function DeliveryRecord({ id }: { id: string }) {
  const query = useQuery(deliveryPageQuery(id));
  const { mode } = deliveryRoute.useSearch();
  const conn = connectivity([query]);
  const unblock = useDeliveryUnblock();
  const park = useDeliveryPark();
  const unpark = useDeliveryUnpark();
  const abandon = useDeliveryAbandon();
  const pending = unblock.isPending || park.isPending || unpark.isPending || abandon.isPending;
  const disabled = conn.offline || pending;
  // The dialog stays mounted so Base UI can return focus to its opener on close.
  const [dialog, setDialog] = useState<'pause' | 'abandon'>('pause');
  const [dialogOpen, setDialogOpen] = useState(false);
  // Set before `mutate`, since the verbs only disable after TanStack re-renders.
  const inFlight = useRef(false);
  const [refusals, setRefusals] = useState(0);
  const refocused = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const control = useRef<HTMLButtonElement | null>(null);
  const { handoff, headingRef } = useRowFocusHandoff(query.data?.decisions.map((d) => d.id) ?? []);
  useLayoutEffect(() => {
    if (control.current && !control.current.isConnected && !dialogOpen) {
      if (document.activeElement === document.body) {
        heading.current?.focus();
      }
      control.current = null;
    }
  });
  // A refused verb takes focus back once its chip is enabled again: the write settled, and the
  // console is online. A refusal that lands offline waits for the connection, not just the settle.
  useEffect(() => {
    if (refusals !== refocused.current && !disabled) {
      refocused.current = refusals;
      control.current?.focus();
      control.current = null;
    }
  }, [refusals, disabled]);
  // Runs a one-tap verb unless another write is already in flight.
  const verb = (
    event: { currentTarget: HTMLButtonElement },
    send: (callbacks: { onError: () => void; onSettled: () => void }) => void,
  ) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    control.current = event.currentTarget;
    send({
      onError: () => setRefusals((n) => n + 1),
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };
  if (isNotFound(query.error)) {
    return <NotFoundPage projectKey={id.split('-')[0]}>No record {id}.</NotFoundPage>;
  }
  if (!query.data) {
    return (
      <>
        <OfflineBanner {...conn} />
        <RecordPending unreachable={query.isError} />
      </>
    );
  }
  const { delivery: d, phase, members, decisions, followUps, journal, now } = query.data;
  const provisional = decisions.filter((x) => x.lifecycle === 'provisional').length;
  const terminal = d.lifecycle === 'landed' || d.lifecycle === 'abandoned';
  const clearStop = () => (
    <ActionButton
      size="sm"
      variant="attentionOutline"
      className={PHONE_TOUCH_TARGET}
      disabled={disabled}
      onClick={(event) => {
        verb(event, (callbacks) => unblock.mutate({ id }, callbacks));
      }}
    >
      Clear stop
    </ActionButton>
  );
  const distribution = memberDistribution(members);
  const head = (
    <header className="flex flex-col gap-2">
      <nav aria-label="Path" className="flex flex-wrap items-center gap-2 text-tag text-ink-dim">
        <Link to="/p/$key" params={{ key: d.project_key }}>
          {d.project_key}
        </Link>
        <span>›</span>
        <Link {...nodeLink(phase.id)} className="wrap-anywhere">
          {phase.title}
        </Link>
        <span>›</span>
        <span>{d.id}</span>
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-mono-id text-ink-dim">{d.id} · delivery</span>
        <DeliveryWords delivery={d} />
      </div>
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-dossier font-bold wrap-anywhere text-ink-bright md:text-header"
      >
        {d.title}
      </h1>
      <DeliveryTime delivery={d} />
      {!terminal && (
        <div className="flex flex-wrap gap-2">
          {d.hold === 'stopped' && clearStop()}
          {d.hold === 'none' && (
            <ActionButton
              size="sm"
              variant="outline"
              className={PHONE_TOUCH_TARGET}
              disabled={disabled}
              onClick={(event) => {
                control.current = event.currentTarget;
                setDialog('pause');
                setDialogOpen(true);
              }}
            >
              Pause…
            </ActionButton>
          )}
          {d.hold === 'paused' && (
            <ActionButton
              size="sm"
              variant="outline"
              className={PHONE_TOUCH_TARGET}
              disabled={disabled}
              onClick={(event) => {
                verb(event, (callbacks) => unpark.mutate({ id }, callbacks));
              }}
            >
              Resume
            </ActionButton>
          )}
          <ActionButton
            size="sm"
            variant="destructiveOutline"
            className={PHONE_TOUCH_TARGET}
            disabled={disabled}
            onClick={(event) => {
              control.current = event.currentTarget;
              setDialog('abandon');
              setDialogOpen(true);
            }}
          >
            Abandon…
          </ActionButton>
        </div>
      )}
    </header>
  );
  const rail = (
    <>
      <RailSection label="Follow-ups">
        {followUps.length === 0 && <Empty lead="No follow-ups." />}
        {followUps.map((row) => (
          <div key={row.id}>
            <BrowserRow
              to={row.id.includes('-s') ? seedLink(row.id) : nodeLink(row.id)}
              id={row.id}
              title={row.title}
              meta={row.status}
            />
            <ul className="space-y-1 pl-4 text-xs text-ink-dim">
              {row.items.map((item) => (
                <li key={item.number} className="wrap-anywhere">
                  {{ checked: '✓', dropped: '−', open: '○' }[item.state]} {item.content} ·{' '}
                  {item.state}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </RailSection>
      <RailSection label="Known limitations">
        {d.limitations.length === 0 && <Empty lead="No known limitations." />}
        {d.limitations.map((l) => (
          <p key={l.number} className="text-xs wrap-anywhere text-ink-dim">
            {l.text}
          </p>
        ))}
      </RailSection>
      <RailSection label="Declined findings">
        {d.declined.length === 0 && <Empty lead="No declined findings." />}
        {d.declined.map((l) => (
          <p key={l.number} className="text-xs wrap-anywhere text-ink-dim">
            <strong>{l.finding}</strong> · <span>{l.reason}</span>
          </p>
        ))}
      </RailSection>
      {/* Facts top the rail from lg up, so the journal is last on screen there. */}
      <RailSection label="Recent run journal" className="lg:border-b-0 lg:pb-0">
        {journal.map((entry) => (
          <p key={entry.number} className="text-xs wrap-anywhere text-ink-dim">
            <time className="mr-2 text-ink-dim">{absoluteTime(entry.at)}</time>
            <span>{entry.content}</span>
          </p>
        ))}
        {d.journal.artifacts.map((artifact) => (
          <Link
            key={artifact}
            {...artifactLink(artifact)}
            className={`text-xs text-accent-foreground ${PHONE_TOUCH_TARGET}`}
          >
            {artifact} · frozen journal
          </Link>
        ))}
        {!journal.length && !d.journal.artifacts.length && <Empty lead="No journal entries yet." />}
      </RailSection>
      <div className="lg:-order-1 lg:border-b lg:border-line lg:pb-4">
        <DeliveryFacts delivery={d} />
      </div>
    </>
  );
  return (
    <>
      <OfflineBanner {...conn} />
      {mode === 'decisions' && <DeliveryDecisions key={id} id={id} />}
      <Reason
        open={dialogOpen}
        required
        commitDisabled={disabled}
        title={`${dialog === 'pause' ? 'Pause' : 'Abandon'} ${id}`}
        // A disabled opener (offline, or a write in flight) cannot take focus back.
        finalFocus={() =>
          control.current?.isConnected && !control.current.disabled
            ? control.current
            : heading.current
        }
        onClose={() => {
          setDialogOpen(false);
        }}
        commits={[
          {
            label: dialog === 'pause' ? 'Pause delivery' : 'Abandon delivery',
            onCommit: async (reason) => {
              if (dialog === 'pause') {
                await park.mutateAsync({ id, reason });
              } else {
                await abandon.mutateAsync({ id, reason });
              }
            },
            variant: dialog === 'pause' ? 'outline' : 'destructiveOutline',
          },
        ]}
      />
      <RecordLayout large head={head} rail={rail} railLabel="Delivery details">
        {d.hold !== 'none' && (
          <section
            aria-label={d.hold === 'stopped' ? 'Stopped' : 'Paused'}
            className={
              d.hold === 'stopped'
                ? 'rounded-lg border border-attention/30 bg-attention/10 p-3 text-attention-foreground'
                : 'rounded-lg border border-line p-3 text-ink'
            }
          >
            <h2 className="microlabel">{d.hold === 'stopped' ? 'Stopped' : 'Paused'}</h2>
            <p className="text-meta wrap-anywhere">{d.hold_reason}</p>
            {!terminal && d.hold === 'stopped' && clearStop()}
          </section>
        )}
        <BrowserGroup
          headingRef={headingRef}
          label="Needs you"
          count={decisions.length > 0 ? decisions.length : undefined}
          hint="Only your action moves these."
          labelClassName="text-attention-foreground"
        >
          {!decisions.length && <Empty lead="No open decisions." />}
          {provisional > 0 && (
            <p className="mb-1">
              <DecisionsEntry set={{ id: d.id, kind: 'delivery' }}>
                {entryLabel(provisional)}
              </DecisionsEntry>
            </p>
          )}
          {decisions.map((decision) => (
            <DecisionRow
              currentDelivery={d.id}
              key={decision.id}
              decision={decision}
              actions={
                decision.lifecycle === 'provisional' ? (
                  <DecisionActions decision={decision} offline={conn.offline} handoff={handoff} />
                ) : undefined
              }
            />
          ))}
        </BrowserGroup>
        <BrowserGroup label="Now" count={now.length > 0 ? now.length : undefined}>
          {!now.length && <Empty lead="No members in flight." />}
          {now.map((row) => (
            <NowRow key={row.task.id} row={row} />
          ))}
        </BrowserGroup>
        <BrowserGroup label="Progress">
          <DistributionBar distribution={distribution} />
          <p className="text-tag text-ink-dim">
            {STATUS_ORDER.filter((s) => distribution[s])
              .map((s) => `${String(distribution[s])} ${STATUS_META[s].label.toLowerCase()}`)
              .join(' · ')}
          </p>
          {members
            .filter((m) => !now.some((row) => row.task.id === m.id))
            .map((task) => (
              <BrowserRow
                key={task.id}
                to={nodeLink(task.id)}
                id={task.id}
                title={task.title}
                leading={<StatusDot status={task.status} />}
                meta={STATUS_META[task.status].label}
              />
            ))}
        </BrowserGroup>
      </RecordLayout>
    </>
  );
}
