import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { isNotFound } from '../api/errors';
import { deliveryPageQuery } from '../api/view-queries';
import { BrowserRow } from '../components/browser-list';
import { DeliveryTime, DeliveryWords, memberDistribution } from '../components/delivery-summary';
import { DistributionBar } from '../components/distribution-bar';
import { ExternalRef } from '../components/node-record';
import { OfflineBanner } from '../components/offline-banner';
import { OpenInT3 } from '../components/open-in-t3';
import { RailSection, RecordLayout, RecordPending } from '../components/record-layout';
import { StatusDot } from '../components/status-dot';
import { Empty, NowRow } from '../components/work-sections';
import { connectivity } from '../lib/connectivity';
import { deliveryIdOf, artifactLink, seedLink, nodeLink } from '../lib/record-url';
import { STATUS_META, STATUS_ORDER } from '../lib/status';
import { absoluteTime } from '../lib/time';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { deliveryRoute } from '../router';
import { NotFoundPage } from './not-found';

/** A delivery is a read-only dossier; decisions show the answer already taken. */
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
  const conn = connectivity([query]);
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
  const distribution = memberDistribution(members);
  const head = (
    <header className="flex flex-col gap-2">
      <nav aria-label="Path" className="flex flex-wrap items-center gap-2 text-tag text-ink-dim">
        <Link to="/p/$key" params={{ key: d.project_key }}>
          {d.project_key}
        </Link>
        <span>›</span>
        <Link {...nodeLink(phase.id)}>{phase.title}</Link>
        <span>›</span>
        <span>{d.id}</span>
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-mono-id text-ink-faint">{d.id} · delivery</span>
        <DeliveryWords delivery={d} />
      </div>
      <h1 className="text-dossier font-bold text-ink-bright md:text-header">{d.title}</h1>
      <DeliveryTime delivery={d} />
    </header>
  );
  const rail = (
    <>
      <div className="hidden lg:block">
        <RailSection label="Facts">
          <dl className="flex flex-col gap-2 text-xs text-ink-dim">
            <dt>Branch</dt>
            <dd className="font-mono break-all">{d.branch ?? 'None'}</dd>
            <dt>Pull request</dt>
            <dd>{d.external_ref ? <ExternalRef value={d.external_ref} /> : 'None'}</dd>
            <dt>Thread</dt>
            <dd>
              <OpenInT3 harness={d.harness} host={d.host} session={d.session} />
            </dd>
            <dt>Start</dt>
            <dd>
              {absoluteTime(
                d.history.find((h) => h.kind === 'lifecycle' && h.to_value === 'running')?.at ??
                  d.created_at,
              )}
            </dd>
            <dt>Time</dt>
            <dd>
              <DeliveryTime delivery={d} />
            </dd>
          </dl>
        </RailSection>
      </div>
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
                <li key={item.number}>
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
          <p key={l.number} className="text-xs text-ink-dim">
            {l.text}
          </p>
        ))}
      </RailSection>
      <RailSection label="Declined findings">
        {d.declined.length === 0 && <Empty lead="No declined findings." />}
        {d.declined.map((l) => (
          <p key={l.number} className="text-xs text-ink-dim">
            <strong>{l.finding}</strong> · <span>{l.reason}</span>
          </p>
        ))}
      </RailSection>
      <RailSection label="Recent run journal">
        {journal.map((entry) => (
          <p key={entry.number} className="text-xs text-ink-dim">
            <time className="mr-2 text-ink-faint">{absoluteTime(entry.at)}</time>
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
    </>
  );
  return (
    <>
      <OfflineBanner {...conn} />
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
            <p className="text-meta">{d.hold_reason}</p>
          </section>
        )}
        <RailSection label="Open decisions">
          {!decisions.length && <Empty lead="No open decisions." />}
          {decisions.map((decision) => (
            <div
              key={decision.id}
              className="flex flex-col gap-2 rounded-lg border border-attention/30 bg-attention/10 p-3 text-meta text-attention-foreground"
            >
              <span className="text-tag">
                {decision.id} · {decision.class}
              </span>
              <h3 className="font-semibold">{decision.question}</h3>
              <ol className="list-inside list-decimal">
                {decision.options.map((option) => (
                  <li key={option}>{option}</li>
                ))}
              </ol>
              <p>Answer taken: {decision.options[decision.taken - 1] ?? 'None'}</p>
              <div className="flex flex-wrap gap-2">
                {decision.tasks.map((task) => (
                  <Link
                    key={task}
                    {...nodeLink(task)}
                    className={`underline ${PHONE_TOUCH_TARGET}`}
                  >
                    {task}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </RailSection>
        <RailSection label="Now">
          {!now.length && <Empty lead="No members in flight." />}
          {now.map((row) => (
            <NowRow key={row.task.id} row={row} />
          ))}
        </RailSection>
        <RailSection label="Progress">
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
        </RailSection>
      </RecordLayout>
    </>
  );
}
