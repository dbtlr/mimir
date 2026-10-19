import { SEED_KIND_VALUES } from '@mimir/contract';
import type { EngineNode, SeedKind, SeedLane } from '@mimir/contract';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { seedQuery, upstreamTasksQuery } from '../api/browse-queries';
import type { EngineSeed } from '../api/browse-queries';
import { isNotFound } from '../api/errors';
import { nodeQuery } from '../api/node-queries';
import { useUpdateSeed } from '../api/seed-mutations';
import { projectsQuery } from '../api/shell-queries';
import { projectKeyOf } from '../api/types';
import { DescriptionSection, MetaRow } from '../components/node-record';
import { OfflineBanner } from '../components/offline-banner';
import { RailSection, RecordLayout, RecordPending } from '../components/record-layout';
import type { RailChip } from '../components/record-layout';
import { SeedKindChip } from '../components/seed-kind-chip';
import { SeedPromoteSheet } from '../components/seed-promote-sheet';
import { SeedVerbs } from '../components/seed-verbs';
import { StatusDot } from '../components/status-dot';
import { ActionButton } from '../components/ui/action-button';
import { Skeleton } from '../components/ui/skeleton';
import { copyText } from '../lib/clipboard';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { useRememberRecord } from '../lib/recent-records';
import { nodeLink, seedIdOf, seedPath } from '../lib/record-url';
import { laneOf } from '../lib/seed-lanes';
import { STATUS_META, isSettledTask, recordStanding } from '../lib/status';
import { ago, calendarDate } from '../lib/time';
import { seedRoute } from '../router';
import { NotFoundPage } from './not-found';

/**
 * `/p/$key/s$seq` — a seed's own page (ADR 0013, v0.23 refinement; MMR-451).
 * It reads as a request, then asks for a decision: who asks whom, the body,
 * what came of it, and the triage verbs the seed's lane offers. A suffix off
 * the seed grammar shows the not-found state without a lookup.
 */
export function SeedPage() {
  const { key, seq } = seedRoute.useParams();
  const seedId = seedIdOf(key, seq);
  if (seedId === undefined) {
    return (
      <NotFoundPage projectKey={key.toUpperCase()}>
        No record at /p/{key}/s{seq}.
      </NotFoundPage>
    );
  }
  return <SeedRecord key={seedId} seedId={seedId} />;
}

/** A seed is editable until a terminal verb freezes it. */
const isLive = (seed: EngineSeed): boolean => laneOf(seed) !== 'settled';

/** The lane as the page head names it; a settled seed names how it ended. */
function laneLabel(seed: EngineSeed): string {
  switch (laneOf(seed)) {
    case 'untriaged': {
      return 'Untriaged';
    }
    case 'ready': {
      return 'Ready to resolve';
    }
    case 'promoted': {
      return 'Promoted';
    }
    case 'parked': {
      return 'Parked';
    }
    default: {
      return seed.lifecycle === 'rejected' ? 'Rejected' : 'Resolved';
    }
  }
}

const LANE_BADGE: Record<SeedLane, string> = {
  parked: 'text-status-parked inset-ring-line-bright',
  promoted: 'text-ink-dim inset-ring-line-bright',
  ready: 'bg-attention/12 text-attention inset-ring-attention/30',
  settled: 'text-ink-faint inset-ring-line',
  untriaged: 'bg-accent/12 text-accent-foreground inset-ring-accent/30',
};

/** The decision block's wash, keyed to the lane that asks for it. */
const DECISION_BOX: Record<Exclude<SeedLane, 'settled'>, { box: string; label: string }> = {
  parked: { box: 'bg-well-850 inset-ring-line-bright', label: 'text-status-parked' },
  promoted: { box: 'bg-well-850 inset-ring-line-bright', label: 'text-ink-dim' },
  ready: { box: 'bg-attention/8 inset-ring-attention/30', label: 'text-attention' },
  untriaged: { box: 'bg-accent/6 inset-ring-accent/30', label: 'text-accent-foreground' },
};

/** A project as the request card names it: its title, then its key. */
function ProjectName({ id, title }: { id: string; title?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span aria-hidden className="size-2 self-center rounded-[2px] inset-ring inset-ring-accent" />
      {title !== undefined && <span className="font-semibold text-ink-bright">{title}</span>}
      <span className="font-mono text-mono-id text-ink-faint">{id}</span>
    </span>
  );
}

/** Who asks whom: the requesting board asks the owning board, or you ask it. */
function RequestCard({
  seed,
  titleOf,
}: {
  seed: EngineSeed;
  titleOf: (key: string) => string | undefined;
}) {
  const requester = seed.requester;
  return (
    <div
      role="group"
      aria-label="Request"
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg bg-well-850 px-3.5 py-2.5 text-meta inset-ring inset-ring-line"
    >
      {requester === null ? (
        <span className="font-semibold text-ink-bright">You</span>
      ) : (
        <ProjectName id={requester} title={titleOf(requester)} />
      )}
      <span className="text-ink-dim">{requester === null ? 'ask' : 'asks'}</span>
      <ProjectName id={seed.project} title={titleOf(seed.project)} />
      <span className="ml-auto text-tag text-ink-faint">
        filed {calendarDate(seed.createdAt)} · {ago(seed.createdAt)}
      </span>
    </div>
  );
}

/** A task as a node read serves it: what its standing and row read. */
type OutcomeNode = Pick<EngineNode, 'completedAt' | 'status' | 'title' | 'type' | 'updatedAt'>;

/** One task that came of the seed: its state, linked to its page. */
type Outcome = { id: string; node?: OutcomeNode; upstream: boolean };

/** Whether the read of the tasks naming the seed upstream has answered. */
type UpstreamRead = 'pending' | 'failed' | 'answered';

function upstreamReadOf(read: { data?: unknown; isError: boolean }): UpstreamRead {
  if (read.data !== undefined) {
    return 'answered';
  }
  return read.isError ? 'failed' : 'pending';
}

/**
 * What came of the seed: the tasks promoted from it, then the tasks on any
 * board that name it as upstream. A spawned row links before its task loads.
 * "Nothing yet" waits for the upstream read to answer, so a slow or failed
 * read never claims that nothing waits on the seed.
 */
function OutcomeSection({
  outcomes,
  upstreamRead,
}: {
  outcomes: readonly Outcome[];
  upstreamRead: UpstreamRead;
}) {
  return (
    <section aria-label="What came of it" className="flex flex-col gap-1.5">
      <h2 className="microlabel border-b border-line pb-1.5 text-ink-faint">What came of it</h2>
      {outcomes.length === 0 && upstreamRead === 'pending' && <Skeleton className="h-5 w-2/3" />}
      {outcomes.length === 0 && upstreamRead === 'answered' && (
        <p className="text-xs text-ink-faint">
          Nothing yet. No task has been promoted from this seed, and none waits on it.
        </p>
      )}
      {outcomes.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {outcomes.map(({ id, node, upstream }) => (
            <li key={id}>
              <Link
                {...nodeLink(id)}
                className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 text-xs text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
              >
                {node !== undefined && <StatusDot status={node.status} />}
                <span className="shrink-0 font-mono text-mono-id text-accent-foreground">{id}</span>
                <span className="min-w-0 flex-1 truncate">{node?.title}</span>
                {upstream && node !== undefined && (
                  <span className="microlabel shrink-0 text-ink-faint">
                    {isSettledTask(node) ? 'named it upstream' : 'waits on it'}
                  </span>
                )}
                {node !== undefined && (
                  <span className="shrink-0 font-mono text-mono-id text-ink-faint">
                    {recordStanding(node)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {upstreamRead === 'failed' && (
        <p className="text-xs text-ink-faint">Couldn’t check which tasks wait on this seed.</p>
      )}
    </section>
  );
}

/** The one sentence the decision block opens with, by lane. */
function decisionPrompt(
  seed: EngineSeed,
  ownerTitle: string,
  spawned: readonly (OutcomeNode | undefined)[],
): string {
  const lane = laneOf(seed);
  if (lane === 'untriaged') {
    return `Promote it into work on the ${ownerTitle} board, reject it with a reason, or park it for later.`;
  }
  if (lane === 'parked') {
    return `It is set aside, so it no longer counts as untriaged. Unpark it to decide now, or promote it into work on the ${ownerTitle} board.`;
  }
  if (lane === 'ready') {
    const only = spawned.length === 1 ? spawned[0] : undefined;
    const settled =
      only === undefined
        ? 'Every task it spawned has settled.'
        : `Its only task was ${STATUS_META[only.status].label.toLowerCase()}.`;
    return `${settled} Resolve the seed, or promote it again.`;
  }
  return 'Its work is under way. Promote it again for more, or reject it with a reason.';
}

type SeedEdit = { title?: string; kind?: SeedKind; description?: string };

/**
 * Only the fields an edit changed. A seed filed before the title cap keeps
 * its long title through an edit of its kind or body, because an unchanged
 * title is never sent back for the server to re-check.
 */
function changedFields(
  seed: EngineSeed,
  next: { title: string; kind: SeedKind; description: string },
): SeedEdit {
  const fields: SeedEdit = {};
  if (next.title !== seed.title) {
    fields.title = next.title;
  }
  if (next.kind !== seed.kind) {
    fields.kind = next.kind;
  }
  if (next.description !== (seed.description ?? '')) {
    fields.description = next.description;
  }
  return fields;
}

/** The seed's title, kind, and body, edited in place of the page body. */
function SeedEditForm({
  seed,
  submitting,
  onSave,
  onCancel,
}: {
  seed: EngineSeed;
  submitting: boolean;
  onSave: (fields: SeedEdit) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(seed.title);
  const [kind, setKind] = useState<SeedKind>(seed.kind);
  const [description, setDescription] = useState(seed.description ?? '');
  const field =
    'rounded-[9px] border border-line-bright bg-well-900 px-3 py-2 text-body text-ink caret-accent outline-none focus-visible:border-accent/60';
  const label = 'microlabel text-ink-faint';
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(changedFields(seed, { description: description.trim(), kind, title: title.trim() }));
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className={label}>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1.5 self-start">
        <span className={label}>Kind</span>
        <select
          value={kind}
          onChange={(e) => {
            const next = SEED_KIND_VALUES.find((k) => k === e.target.value);
            if (next !== undefined) {
              setKind(next);
            }
          }}
          className={field}
        >
          {SEED_KIND_VALUES.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={label}>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={cn(field, 'min-h-40 resize-y leading-[1.7]')}
        />
      </label>
      <div className="flex items-center gap-2">
        <ActionButton type="submit" size="sm" disabled={submitting || title.trim() === ''}>
          Save
        </ActionButton>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-xs text-ink-dim hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The seed's Edit and Copy link. */
function ActionsPanel({
  seed,
  offline,
  onEdit,
}: {
  seed: EngineSeed;
  offline: boolean;
  onEdit: (() => void) | null;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {onEdit !== null && isLive(seed) && (
        <ActionButton size="sm" variant="outline" disabled={offline} onClick={onEdit}>
          Edit
        </ActionButton>
      )}
      <ActionButton
        size="sm"
        variant="outline"
        onClick={() =>
          void copyText(`${globalThis.location.origin}${seedPath(seed.id)}`, {
            copied: `Copied the link to ${seed.id}`,
            failed: `Couldn't copy the link to ${seed.id}.`,
          })
        }
      >
        Copy link
      </ActionButton>
    </div>
  );
}

function DetailsPanel({ seed }: { seed: EngineSeed }) {
  return (
    <dl className="flex flex-col gap-1">
      <MetaRow label="Kind">{seed.kind}</MetaRow>
      <MetaRow label="Filed">
        {calendarDate(seed.createdAt)} · {ago(seed.createdAt)}
      </MetaRow>
      <MetaRow label="Project">{seed.project}</MetaRow>
      <MetaRow label="Link">{seedPath(seed.id)}</MetaRow>
    </dl>
  );
}

function SeedRecord({ seedId }: { seedId: string }) {
  const seed = useQuery(seedQuery(seedId));
  const projects = useQuery(projectsQuery);
  const upstream = useQuery(upstreamTasksQuery(seedId));
  const spawnedIds = seed.data?.spawned ?? [];
  const spawned = useQueries({ queries: spawnedIds.map((id) => nodeQuery(id)) });
  const update = useUpdateSeed(seedId);
  const [editing, setEditing] = useState(false);
  const [promoting, setPromoting] = useState<EngineSeed | null>(null);
  const conn = connectivity([seed]);
  const data = seed.data;
  useRememberRecord(data && { id: seedId, kind: 'seed', project: data.project, title: data.title });

  if (isNotFound(seed.error)) {
    return <NotFoundPage projectKey={projectKeyOf(seedId)}>No record {seedId}.</NotFoundPage>;
  }
  if (data === undefined) {
    return (
      <>
        <OfflineBanner {...conn} />
        <RecordPending unreachable={seed.isError} />
      </>
    );
  }

  const offline = conn.offline;
  const titleOf = (key: string) => projects.data?.find((p) => p.id === key)?.title;
  const ownerTitle = titleOf(data.project) ?? data.project;
  const spawnedNodes = spawned.map((q) => q.data);
  const outcomes: Outcome[] = [
    ...spawnedIds.map((id, i) => ({ id, node: spawnedNodes[i], upstream: false })),
    ...(upstream.data?.items ?? [])
      .filter((n) => !spawnedIds.includes(n.id))
      .map((n) => ({ id: n.id, node: n, upstream: true })),
  ];

  async function save(fields: SeedEdit) {
    if (Object.keys(fields).length === 0) {
      setEditing(false);
      return;
    }
    try {
      await update.mutateAsync(fields);
      setEditing(false);
    } catch {
      // toasted by the hook; keep the editor open
    }
  }

  const actions = (
    <ActionsPanel seed={data} offline={offline} onEdit={editing ? null : () => setEditing(true)} />
  );
  const details = <DetailsPanel seed={data} />;
  const chips: RailChip[] = [
    { content: actions, label: 'Actions' },
    { content: details, label: 'Details' },
  ];
  const rail = (
    <>
      <RailSection label="Actions">{actions}</RailSection>
      <RailSection label="Details">{details}</RailSection>
    </>
  );

  const crumb =
    'rounded-sm font-mono text-tag wrap-anywhere text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent';
  const fromOtherBoard = data.requester !== null && data.requester !== data.project;
  const lane = laneOf(data);
  const head = (
    <header className="flex flex-col gap-1.5">
      <nav aria-label="Path" className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <Link to="/p/$key" params={{ key: data.project }} className={crumb}>
          {ownerTitle}
        </Link>
        <span aria-hidden className="text-tag text-ink-faint">
          ›
        </span>
        <Link to="/p/$key/seeds" params={{ key: data.project }} className={crumb}>
          Seeds
        </Link>
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-mono-id text-ink-faint">{seedId} · seed</span>
        <SeedKindChip kind={data.kind} />
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-tag font-semibold inset-ring',
            LANE_BADGE[lane],
          )}
        >
          {laneLabel(data)}
        </span>
        {fromOtherBoard && data.requester !== null && (
          <span className="text-tag text-ink-faint">
            from{' '}
            <Link to="/p/$key" params={{ key: data.requester }} className={crumb}>
              {titleOf(data.requester) ?? data.requester}
            </Link>
          </span>
        )}
      </div>
      <h1 className="text-dossier leading-[1.35] font-bold tracking-[-0.01em] wrap-anywhere text-ink-bright md:text-header">
        {data.title}
      </h1>
    </header>
  );

  const decision: ReactNode =
    lane === 'settled' ? null : (
      <section
        aria-label="Your call"
        className={cn('flex flex-col gap-2.5 rounded-lg p-3.5 inset-ring', DECISION_BOX[lane].box)}
      >
        <h2 className={cn('microlabel', DECISION_BOX[lane].label)}>Your call</h2>
        <p className="text-meta text-ink">{decisionPrompt(data, ownerTitle, spawnedNodes)}</p>
        <SeedVerbs seed={data} onPromote={setPromoting} offline={offline} withSpawned={false} />
      </section>
    );

  return (
    <>
      <OfflineBanner {...conn} />
      <RecordLayout
        head={head}
        rail={rail}
        chips={chips}
        className={cn(offline && 'offline-demoted')}
      >
        {editing ? (
          <SeedEditForm
            seed={data}
            submitting={update.isPending}
            onSave={(fields) => void save(fields)}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <RequestCard seed={data} titleOf={titleOf} />
            <DescriptionSection description={data.description} />
            <OutcomeSection outcomes={outcomes} upstreamRead={upstreamReadOf(upstream)} />
            {decision}
          </>
        )}
      </RecordLayout>
      {promoting !== null && (
        <SeedPromoteSheet
          seed={promoting}
          open
          onOpenChange={(next) => {
            if (!next) {
              setPromoting(null);
            }
          }}
          offline={offline}
        />
      )}
    </>
  );
}
