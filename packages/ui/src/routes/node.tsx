import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { isNotFound } from '../api/errors';
import { annotationsQuery, nodeQuery, scratchpadsQuery, treeQuery } from '../api/queries';
import type { WireNode, WireScratchpadRow, WireTreeNode } from '../api/types';
import { projectKeyOf } from '../api/types';
import { AnnotationComposer } from '../components/annotation-composer';
import { DirectionLine } from '../components/direction-line';
import { MarkdownBody } from '../components/markdown-body';
import { MoveDialog } from '../components/move-dialog';
import {
  ExternalRef,
  HoldCallout,
  MetaRow,
  RefRow,
  SignalBadges,
  VerdictBlock,
  awaitsVerdict,
  hasSignals,
  prerequisiteRows,
  recordVerbs,
  useNodeEdit,
  useNodeVerbs,
} from '../components/node-record';
import { FeedList } from '../components/node-timeline';
import { OfflineBanner } from '../components/offline-banner';
import { RailSection, RecordLayout } from '../components/record-layout';
import type { RailChip } from '../components/record-layout';
import { StatusBadge } from '../components/status-badge';
import { TaskForm } from '../components/task-form';
import { ActionButton } from '../components/ui/action-button';
import { Skeleton } from '../components/ui/skeleton';
import { ancestorsOf } from '../lib/ancestry';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { nodeIdOf, nodeLink } from '../lib/record-url';
import { absoluteTime } from '../lib/time';
import { buildFeed } from '../lib/timeline';
import type { VerbSpec } from '../lib/transitions';
import { nodeRoute } from '../router';
import { NotFoundPage } from './not-found';

/**
 * `/p/$key/$seq` — a work node's own page (ADR 0013, v0.23 refinement). The
 * path is the node id split at its hyphen; a suffix that is not a node's shows
 * the not-found state without a lookup.
 */
export function NodePage() {
  const { key, seq } = nodeRoute.useParams();
  const nodeId = nodeIdOf(key, seq);
  if (nodeId === undefined) {
    return (
      <NotFoundPage projectKey={key.toUpperCase()}>
        No record at /p/{key}/{seq}.
      </NotFoundPage>
    );
  }
  return <NodeRecord key={nodeId} nodeId={nodeId} />;
}

/** The path above a record: its project, then each container down to its parent. */
function Crumbs({
  projectKey,
  tree,
  nodeId,
}: {
  projectKey: string;
  tree?: WireTreeNode;
  nodeId: string;
}) {
  const ancestors = tree === undefined ? [] : (ancestorsOf(tree, nodeId) ?? []);
  const crumb =
    'rounded-sm font-mono text-tag text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <nav aria-label="Path" className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <Link to="/p/$key" params={{ key: projectKey }} className={crumb}>
        {tree?.title ?? projectKey}
      </Link>
      {ancestors.map((a) => (
        <span key={a.id} className="flex items-baseline gap-1.5">
          <span aria-hidden className="text-tag text-ink-faint">
            ›
          </span>
          <Link {...nodeLink(a.id)} className={crumb}>
            {a.title}
          </Link>
        </span>
      ))}
    </nav>
  );
}

/** A task's Edit, Move…, and the transition verbs it offers outside its verdict block. */
function ActionsPanel({
  node,
  offline,
  onEdit,
  onMove,
  onVerb,
}: {
  node: WireNode;
  offline: boolean;
  onEdit: () => void;
  onMove: () => void;
  onVerb: (v: VerbSpec) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <ActionButton size="sm" variant="outline" disabled={offline} onClick={onEdit}>
          Edit
        </ActionButton>
        <ActionButton size="sm" variant="outline" disabled={offline} onClick={onMove}>
          Move…
        </ActionButton>
        {recordVerbs(node).map((v) => (
          <ActionButton
            key={v.verb}
            size="sm"
            variant="outline"
            disabled={offline}
            onClick={() => onVerb(v)}
          >
            {v.label}
            {v.needsReason && '…'}
          </ActionButton>
        ))}
      </div>
      {awaitsVerdict(node) && (
        <p className="text-tag text-ink-faint">
          Approve and Request changes sit in the verdict block.
        </p>
      )}
    </div>
  );
}

/** Where an agent is working on the node: harness, branch, host, external ref, and Scratchpads. */
function AgentPanel({
  node,
  scratchpads,
}: {
  node: WireNode;
  scratchpads: readonly WireScratchpadRow[];
}) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      {node.harness != null && <span className="text-ink">{node.harness}</span>}
      {node.branch != null && (
        <span className="font-mono text-mono-id break-all text-ink-dim">{node.branch}</span>
      )}
      {node.host != null && (
        <span className="font-mono text-mono-id text-ink-faint">on {node.host}</span>
      )}
      {node.external_ref != null && <ExternalRef value={node.external_ref} />}
      {scratchpads.map((s) => (
        <span key={s.id} className="text-ink-dim">
          <span className="microlabel mr-1.5 text-ink-faint">Scratchpad</span>
          {s.title}
        </span>
      ))}
    </div>
  );
}

function hasAgentContext(node: WireNode, scratchpads: readonly WireScratchpadRow[]): boolean {
  return (
    node.harness != null ||
    node.branch != null ||
    node.host != null ||
    node.external_ref != null ||
    scratchpads.length > 0
  );
}

function ArtifactLinks({ node }: { node: WireNode }) {
  const artifacts = node.artifacts ?? [];
  if (artifacts.length === 0) {
    return <p className="text-xs text-ink-faint">None yet.</p>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {artifacts.map((a) => (
        <Link
          key={a.id}
          to="/artifacts"
          search={{ a: a.id, from: node.id }}
          className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-0.5 text-xs text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span aria-hidden className="text-accent-foreground select-none">
            ❄
          </span>
          <span className="truncate">{a.title}</span>
        </Link>
      ))}
    </div>
  );
}

function DetailsPanel({ node }: { node: WireNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      {hasSignals(node) && <SignalBadges node={node} />}
      <dl className="flex flex-col gap-1">
        {node.target != null && <MetaRow label="target">{node.target}</MetaRow>}
        <MetaRow label="created">{absoluteTime(node.created_at)}</MetaRow>
        <MetaRow label="updated">{absoluteTime(node.updated_at)}</MetaRow>
        {node.completed_at != null && (
          <MetaRow label="completed">{absoluteTime(node.completed_at)}</MetaRow>
        )}
      </dl>
    </div>
  );
}

function NodeRecord({ nodeId }: { nodeId: string }) {
  const projectKey = projectKeyOf(nodeId);
  const node = useQuery(nodeQuery(nodeId));
  const annotations = useQuery(annotationsQuery(nodeId));
  // The tree titles the path and the Scratchpad list names the agent's
  // episode; a miss on either only thins the page, so neither counts toward
  // connectivity.
  // The tree is the whole board, so it is read once rather than polled; a
  // console write invalidates it and returning to the window refetches it.
  const tree = useQuery({ ...treeQuery(projectKey), refetchInterval: false });
  const scratchpadRows = useQuery(scratchpadsQuery(projectKey));
  const edit = useNodeEdit(nodeId);
  const verbs = useNodeVerbs(nodeId);
  const [moving, setMoving] = useState(false);
  const conn = connectivity([node, annotations]);

  if (isNotFound(node.error)) {
    return <NotFoundPage projectKey={projectKey}>No record {nodeId}.</NotFoundPage>;
  }

  const data = node.data;
  if (data === undefined) {
    return (
      <>
        <OfflineBanner {...conn} />
        <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-2 p-5">
          {node.isError ? (
            <p className="text-xs text-status-blocked">
              Unreachable, and nothing cached yet — is `mimir serve` running?
            </p>
          ) : (
            <>
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-7 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </>
          )}
        </main>
      </>
    );
  }

  const scratchpads = (scratchpadRows.data?.items ?? []).filter((s) =>
    s.linked_work.includes(nodeId),
  );
  const prerequisites = data.deps === undefined ? [] : prerequisiteRows(data.deps);
  const blocking = data.deps?.blocking ?? [];
  const artifactCount = data.artifacts?.length ?? 0;
  const feed = buildFeed(data.created_at, data.history, annotations.data?.items);
  const offline = conn.offline;

  // Edit, Move…, and the transitions are task verbs; a container has none
  // yet. They step aside while the edit form is open, as in the dossier: a
  // second Edit would re-snapshot the tag baseline under a form that kept the
  // first one, and a transition would land mid-edit.
  const actions =
    data.type === 'task' && edit.baseline === null ? (
      <ActionsPanel
        node={data}
        offline={offline}
        onEdit={() => edit.begin(data)}
        onMove={() => setMoving(true)}
        onVerb={verbs.handleVerb}
      />
    ) : null;
  const agent = hasAgentContext(data, scratchpads) ? (
    <AgentPanel node={data} scratchpads={scratchpads} />
  ) : null;
  const dependsOn =
    prerequisites.length > 0 ? (
      <RailSection label="Depends on">
        <div className="flex flex-col gap-0.5">
          {prerequisites.map((r) => (
            <RefRow key={r.id} refNode={r} />
          ))}
        </div>
      </RailSection>
    ) : null;
  const blocks =
    blocking.length > 0 ? (
      <RailSection label="Blocks" count={blocking.length}>
        <div className="flex flex-col gap-0.5">
          {blocking.map((r) => (
            <RefRow key={r.id} refNode={r} />
          ))}
        </div>
      </RailSection>
    ) : null;
  const artifacts = (
    <RailSection label="Artifacts" count={artifactCount > 0 ? artifactCount : undefined}>
      <ArtifactLinks node={data} />
    </RailSection>
  );
  const details = <DetailsPanel node={data} />;

  const chips: RailChip[] = [
    ...(actions === null ? [] : [{ content: actions, label: 'Actions' }]),
    {
      content: (
        <>
          {dependsOn}
          {blocks}
          {artifacts}
        </>
      ),
      count: prerequisites.length + blocking.length + artifactCount,
      label: 'Links',
    },
    ...(agent === null ? [] : [{ content: agent, label: 'Agent' }]),
    { content: details, label: 'Details' },
  ];

  const rail = (
    <>
      {actions !== null && <RailSection label="Actions">{actions}</RailSection>}
      {agent !== null && <RailSection label="Agent">{agent}</RailSection>}
      {dependsOn}
      {blocks}
      {artifacts}
      <RailSection label="Details">{details}</RailSection>
    </>
  );

  const head = (
    <header className="flex flex-col gap-1.5">
      <Crumbs projectKey={projectKey} tree={tree.data} nodeId={nodeId} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-mono-id text-ink-faint">
          {nodeId} · {data.type}
        </span>
        <StatusBadge status={data.status} pill />
      </div>
      <h1 className="text-dossier leading-[1.35] font-bold tracking-[-0.01em] text-ink-bright md:text-header">
        {data.title}
      </h1>
    </header>
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
        {edit.baseline !== null ? (
          <TaskForm
            mode="edit"
            initial={edit.baseline}
            submitting={edit.submitting}
            onSubmit={edit.handleSubmit}
            onCancel={edit.handleCancel}
          />
        ) : (
          <>
            {awaitsVerdict(data) && (
              <VerdictBlock
                node={data}
                annotations={annotations.data?.items}
                offline={offline}
                onVerb={verbs.handleVerb}
                heading
              />
            )}
            <HoldCallout node={data} />
            {/* Direction (MMR-390) is a container facet: initiatives and
                phases own `## Next`, tasks never do. */}
            {(data.type === 'initiative' || data.type === 'phase') && (
              <DirectionLine
                subject={{ id: data.id, kind: 'node' }}
                title={data.title}
                next={data.next}
                offline={offline}
              />
            )}
            <section className="flex flex-col gap-1.5">
              <h2 className="microlabel border-b border-line pb-1.5 text-ink-faint">Description</h2>
              {data.description != null && data.description.trim() !== '' ? (
                <MarkdownBody breaks className="max-w-none">
                  {data.description}
                </MarkdownBody>
              ) : (
                <p className="text-xs text-ink-faint">No description.</p>
              )}
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="microlabel border-b border-line pb-1.5 text-ink-faint">
                Timeline · {feed.length}
              </h2>
              <FeedList
                items={feed}
                pending={annotations.isPending}
                empty="Nothing yet."
                threaded
              />
              <AnnotationComposer nodeId={nodeId} offline={offline} />
            </section>
          </>
        )}
      </RecordLayout>
      {verbs.dialog}
      <MoveDialog
        nodeId={nodeId}
        currentParent={data.parent}
        open={moving}
        onClose={() => setMoving(false)}
      />
    </>
  );
}
