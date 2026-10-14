import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { isNotFound } from '../api/errors';
import { annotationsQuery, nodeQuery, scratchpadsQuery, treeQuery } from '../api/queries';
import type { WireNode, WireScratchpadRow } from '../api/types';
import { projectKeyOf } from '../api/types';
import { AnnotationComposer } from '../components/annotation-composer';
import { GroomingBadge, GroomingChip } from '../components/grooming-chip';
import { GroomingDialog } from '../components/grooming-dialog';
import { MoveDialog } from '../components/move-dialog';
import {
  ArtifactLinks,
  DescriptionSection,
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
import { ParentLink } from '../components/parent-link';
import { RailSection, RecordLayout, RecordPending } from '../components/record-layout';
import type { RailChip } from '../components/record-layout';
import { StatusBadge } from '../components/status-badge';
import { TaskForm } from '../components/task-form';
import { ActionButton } from '../components/ui/action-button';
import { WorkPage } from '../components/work-page';
import type { WorkTab } from '../components/work-page';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { visibleGrooming } from '../lib/grooming';
import { useRememberRecord } from '../lib/recent-records';
import { nodeIdOf } from '../lib/record-url';
import { absoluteTime } from '../lib/time';
import { buildFeed } from '../lib/timeline';
import type { VerbSpec } from '../lib/transitions';
import { nodeRoute } from '../router';
import { NotFoundPage } from './not-found';

/**
 * `/p/$key/$seq` — a work node's own page (ADR 0013, v0.23 refinement). The
 * path is the node id split at its hyphen; a suffix that is not a node's shows
 * the not-found state without a lookup. A task's page carries its actions and
 * agent context; an initiative or phase opens as the work page (MMR-467
 * refinement), its notes behind a Timeline tab.
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

/** A task's Edit, Move…, grooming setter, and the transition verbs it offers outside its verdict block. */
function ActionsPanel({
  node,
  offline,
  onEdit,
  onMove,
  onGroom,
  onVerb,
}: {
  node: WireNode;
  offline: boolean;
  onEdit: () => void;
  onMove: () => void;
  onGroom: () => void;
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
        {visibleGrooming(node) !== undefined && (
          <ActionButton size="sm" variant="outline" disabled={offline} onClick={onGroom}>
            Set grooming…
          </ActionButton>
        )}
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
        <p className="text-tag text-ink-faint">Approve and Send back sit in the verdict block.</p>
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

function DetailsPanel({ node }: { node: WireNode }) {
  const grooming = visibleGrooming(node);
  return (
    <div className="flex flex-col gap-2.5">
      {hasSignals(node) && <SignalBadges node={node} />}
      <dl className="flex flex-col gap-1">
        {grooming !== undefined && (
          <MetaRow label="grooming">
            <GroomingBadge state={grooming} />
          </MetaRow>
        )}
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
  // The tree finds the phone parent link and the Scratchpad list names the
  // agent's episode; a miss on either only thins the page, so neither counts
  // toward connectivity. The tree is the whole board, so it is read once rather
  // than polled; a console write invalidates it and returning to the window
  // refetches it.
  const tree = useQuery({ ...treeQuery(projectKey), refetchInterval: false });
  const scratchpadRows = useQuery(scratchpadsQuery(projectKey));
  const edit = useNodeEdit(nodeId);
  const verbs = useNodeVerbs(nodeId);
  const [moving, setMoving] = useState(false);
  const [grooming, setGrooming] = useState(false);
  const { tab } = nodeRoute.useSearch();
  const navigate = useNavigate({ from: nodeRoute.fullPath });
  const conn = connectivity([node, annotations]);
  useRememberRecord(
    node.data && { id: nodeId, kind: node.data.type, project: projectKey, title: node.data.title },
  );

  if (isNotFound(node.error)) {
    return <NotFoundPage projectKey={projectKey}>No record {nodeId}.</NotFoundPage>;
  }

  const data = node.data;
  if (data === undefined) {
    return (
      <>
        <OfflineBanner {...conn} />
        <RecordPending unreachable={node.isError} />
      </>
    );
  }

  const feed = buildFeed(data.created_at, data.history, annotations.data?.items);
  const offline = conn.offline;

  // An initiative or phase opens as the work page (MMR-467 refinement), its
  // notes under a Timeline tab that the URL selects.
  if (data.type !== 'task') {
    const timeline = (
      <>
        <FeedList items={feed} pending={annotations.isPending} empty="Nothing yet." threaded />
        <AnnotationComposer nodeId={nodeId} offline={offline} />
      </>
    );
    const onTab = (next: WorkTab) => {
      void navigate({ search: { tab: next === 'timeline' ? 'timeline' : undefined } });
    };
    return (
      <>
        <OfflineBanner {...conn} />
        <WorkPage
          record={data}
          tree={tree.data}
          offline={offline}
          container={{ onTab, tab: tab ?? 'work', timeline, timelineCount: feed.length }}
        />
      </>
    );
  }

  const scratchpads = (scratchpadRows.data?.items ?? []).filter((s) =>
    s.linked_work.includes(nodeId),
  );
  const prerequisites = data.deps === undefined ? [] : prerequisiteRows(data.deps);
  const blocking = data.deps?.blocking ?? [];
  const artifactCount = data.artifacts?.length ?? 0;
  const groomingState = visibleGrooming(data);

  // Edit, Move…, and the transitions step aside while the edit form is open: a
  // second Edit would re-snapshot the tag baseline under a form that kept the
  // first one, and a transition would land mid-edit.
  const actions =
    edit.baseline === null ? (
      <ActionsPanel
        node={data}
        offline={offline}
        onEdit={() => edit.begin(data)}
        onMove={() => setMoving(true)}
        onGroom={() => setGrooming(true)}
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
      <ArtifactLinks artifacts={data.artifacts} />
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
      <ParentLink projectKey={projectKey} tree={tree.data} nodeId={nodeId} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-mono-id text-ink-faint">
          {nodeId} · {data.type}
        </span>
        <StatusBadge status={data.status} pill />
        <GroomingChip node={data} />
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
            <DescriptionSection description={data.description} />
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
      {grooming && groomingState !== undefined && (
        <GroomingDialog
          nodeId={nodeId}
          current={groomingState}
          open
          onClose={() => setGrooming(false)}
        />
      )}
      <MoveDialog
        nodeId={nodeId}
        currentParent={data.parent}
        open={moving}
        onClose={() => setMoving(false)}
      />
    </>
  );
}
