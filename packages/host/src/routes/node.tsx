import type { EngineNode, EngineOutput, EngineTree } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { isNotFound } from '../api/errors';
import { annotationsQuery, nodeQuery, scratchpadsQuery } from '../api/node-queries';
import { treeQuery } from '../api/shell-queries';
import { GroomWithAgentCard } from '../components/agent-card';
import { AnnotationComposer } from '../components/annotation-composer';
import { GroomingBadge } from '../components/grooming-chip';
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
  mainVerbLabel,
  mainVerbs,
  moreVerbs,
  prerequisiteRows,
  useNodeEdit,
  useNodeVerbs,
} from '../components/node-record';
import { FeedList } from '../components/node-timeline';
import { OfflineBanner } from '../components/offline-banner';
import { OpenInT3 } from '../components/open-in-t3';
import type { ActionMenuAction } from '../components/patterns/action-menu';
import { RecordHeader } from '../components/patterns/record-header';
import { RECORD_TYPE_LABEL, RecordMore, moreEntries, recordTrail } from '../components/record-head';
import { RailSection, RecordLayout, RecordPending } from '../components/record-layout';
import type { RailChip } from '../components/record-layout';
import { StatusBadge } from '../components/status-badge';
import {
  T3LaunchSettingsHost,
  canLaunchOnT3,
  useT3LaunchEntries,
} from '../components/t3-launch-control';
import { TaskForm } from '../components/task-form';
import { ActionButton } from '../components/ui/action-button';
import { ContainerPage } from '../components/work-page';
import type { ContainerTab } from '../components/work-page';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { visibleGrooming } from '../lib/grooming';
import { projectKeyOf } from '../lib/project-key';
import { useRememberRecord } from '../lib/recent-records';
import { nodeIdOf } from '../lib/record-url';
import { absoluteTime } from '../lib/time';
import { buildFeed } from '../lib/timeline';
import type { NodeAnnotation } from '../lib/timeline';
import type { VerbSpec } from '../lib/transitions';
import { nodeRoute } from '../router';
import { NotFoundPage } from './not-found';

/** One active Scratchpad on the node's board, with the work it is anchored to. */
type ScratchpadRow = EngineOutput<'scratchList'>[number];

/**
 * `/p/$key/$seq` — a work node's own page (ADR 0013, v0.23 refinement). The
 * path is the node id split at its hyphen; a suffix that is not a node's shows
 * the not-found state without a lookup. Every node opens under the record
 * header (MMR-726): a task's page keeps its body and rail, and an initiative
 * or phase opens as the work page with its tabs, its notes behind Timeline.
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

/** Main conversation, optional whole-task worker, and execution context. */
function AgentPanel({
  node,
  scratchpads,
}: {
  node: EngineNode;
  scratchpads: readonly ScratchpadRow[];
}) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      {node.harness != null && <span className="text-ink">{node.harness}</span>}
      {node.session != null && (
        <span className="text-ink-dim">
          <span className="microlabel text-ink-dim">Main session</span>{' '}
          <span className="inline-block max-w-full font-mono text-mono-id wrap-anywhere">
            {node.session}
          </span>
        </span>
      )}
      {node.workerSession != null && (
        <span className="text-ink-dim">
          <span className="microlabel text-ink-dim">Worker session</span>{' '}
          {node.workerHarness != null && <span>{node.workerHarness} </span>}
          <span className="inline-block max-w-full font-mono text-mono-id wrap-anywhere">
            {node.workerSession}
          </span>
        </span>
      )}
      {node.branch != null && (
        <span className="font-mono text-mono-id break-all text-ink-dim">{node.branch}</span>
      )}
      {node.host != null && (
        <span className="font-mono text-mono-id text-ink-dim">on {node.host}</span>
      )}
      <OpenInT3
        harness={node.harness}
        host={node.host}
        session={node.session}
        className="self-start"
      />
      {node.externalRef != null && <ExternalRef value={node.externalRef} />}
      {scratchpads.map((s) => (
        <span key={s.id} className="text-ink-dim">
          <span className="microlabel mr-1.5 text-ink-dim">Scratchpad</span>
          {s.title}
        </span>
      ))}
    </div>
  );
}

function hasAgentContext(node: EngineNode, scratchpads: readonly ScratchpadRow[]): boolean {
  return (
    node.harness != null ||
    node.session != null ||
    node.workerSession != null ||
    node.branch != null ||
    node.host != null ||
    node.externalRef != null ||
    scratchpads.length > 0
  );
}

function DetailsPanel({ node }: { node: EngineNode }) {
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
        <MetaRow label="created">{absoluteTime(node.createdAt)}</MetaRow>
        <MetaRow label="updated">{absoluteTime(node.updatedAt)}</MetaRow>
        {node.completedAt != null && (
          <MetaRow label="completed">{absoluteTime(node.completedAt)}</MetaRow>
        )}
      </dl>
    </div>
  );
}

function NodeRecord({ nodeId }: { nodeId: string }) {
  const projectKey = projectKeyOf(nodeId);
  const node = useQuery(nodeQuery(nodeId));
  const annotations = useQuery(annotationsQuery(nodeId));
  // The tree finds the header's trail and the Scratchpad list names the
  // agent's episode; a miss on either only thins the page, so neither counts
  // toward connectivity. The tree is the whole board, so it is read once rather
  // than polled; a console write invalidates it and returning to the window
  // refetches it.
  const tree = useQuery({ ...treeQuery(projectKey), refetchInterval: false });
  const scratchpadRows = useQuery(scratchpadsQuery(projectKey));
  const { tab } = nodeRoute.useSearch();
  const navigate = useNavigate({ from: nodeRoute.fullPath });
  // The persister may restore an older read after mount, so freshness is by time, not isFetchedAfterMount.
  const [mountedAt] = useState(() => Date.now());
  const conn = connectivity([node, annotations]);
  useRememberRecord(
    node.data && {
      id: nodeId,
      kind: node.data.type,
      project: projectKey,
      title: node.data.title,
    },
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

  const feed = buildFeed(data.createdAt, data.history, annotations.data?.items);
  const offline = conn.offline;

  // An initiative or phase opens as the work page (MMR-467 and MMR-726
  // refinements), its tabs selected by the URL.
  if (data.type !== 'task') {
    const timeline = (
      <>
        <FeedList items={feed} pending={annotations.isPending} empty="Nothing yet." threaded />
        <AnnotationComposer nodeId={nodeId} offline={offline} />
      </>
    );
    const onTab = (next: ContainerTab, options?: { replace: boolean }) => {
      void navigate({
        replace: options?.replace,
        search: { tab: next === 'work' ? undefined : next },
      });
    };
    return (
      <>
        <OfflineBanner {...conn} />
        <ContainerPage
          record={data}
          tree={tree.data}
          offline={offline}
          container={{
            onTab,
            recordReadAt: node.dataUpdatedAt,
            since: mountedAt,
            tab,
            timeline,
            timelineCount: feed.length,
          }}
        />
      </>
    );
  }

  return (
    <TaskRecord
      node={data}
      tree={tree.data}
      feed={feed}
      annotations={annotations.data?.items}
      annotationsPending={annotations.isPending}
      scratchpadRows={scratchpadRows.data ?? []}
      conn={conn}
    />
  );
}

/**
 * A task's page: the record header, with the state's main action and More
 * (MMR-726), over its body (the verdict's review, a hold, the description,
 * and the timeline) beside the rail of its links, agent, and details.
 */
function TaskRecord({
  node,
  tree,
  feed,
  annotations,
  annotationsPending,
  scratchpadRows,
  conn,
}: {
  node: EngineNode;
  tree: EngineTree | undefined;
  feed: ReturnType<typeof buildFeed>;
  annotations: readonly NodeAnnotation[] | undefined;
  annotationsPending: boolean;
  scratchpadRows: readonly ScratchpadRow[];
  conn: ReturnType<typeof connectivity>;
}) {
  const nodeId = node.id;
  const projectKey = projectKeyOf(nodeId);
  const offline = conn.offline;
  const edit = useNodeEdit(nodeId);
  const verbs = useNodeVerbs(nodeId);
  const [moving, setMoving] = useState(false);
  const [grooming, setGrooming] = useState(false);
  const launchEligible = canLaunchOnT3(node);

  const scratchpads = scratchpadRows.filter((s) => s.linkedWork.includes(nodeId));
  const prerequisites = node.deps === undefined ? [] : prerequisiteRows(node.deps);
  const blocking = node.deps?.blocking ?? [];
  const artifactCount = node.artifacts?.length ?? 0;
  const groomingState = visibleGrooming(node);

  const agent = hasAgentContext(node, scratchpads) ? (
    <AgentPanel node={node} scratchpads={scratchpads} />
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
      <ArtifactLinks artifacts={node.artifacts} />
    </RailSection>
  );
  const details = <DetailsPanel node={node} />;
  const chips: RailChip[] = [
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
      {agent !== null && <RailSection label="Agent">{agent}</RailSection>}
      {dependsOn}
      {blocks}
      {artifacts}
      <RailSection label="Details">{details}</RailSection>
    </>
  );

  const head = (
    <RecordHeader
      trail={recordTrail(projectKey, tree, nodeId)}
      title={node.title}
      status={<StatusBadge status={node.status} />}
      type={RECORD_TYPE_LABEL.task}
      recordId={nodeId}
      summary={node.summary}
      chips={groomingState === undefined ? undefined : <GroomingBadge state={groomingState} />}
      // The actions step aside while the edit form is open: a second Edit would
      // re-snapshot the tag baseline under a form that kept the first one, and
      // a transition would land mid-edit.
      actions={
        edit.baseline === null ? (
          <TaskActions
            node={node}
            offline={offline}
            onEdit={() => edit.begin(node)}
            onMove={() => setMoving(true)}
            onGroom={() => setGrooming(true)}
            onVerb={verbs.handleVerb}
          />
        ) : undefined
      }
    />
  );

  return (
    // Launch in T3's settings form lives above More, so it outlives the menu that opened it.
    <T3LaunchSettingsHost eligible={edit.baseline === null && launchEligible}>
      <OfflineBanner {...conn} />
      <RecordLayout
        head={head}
        rail={rail}
        chips={chips}
        className={cn(offline && 'offline-demoted')}
      >
        {edit.baseline !== null ? (
          <TaskForm
            initial={edit.baseline}
            submitting={edit.submitting}
            onSubmit={edit.handleSubmit}
            onCancel={edit.handleCancel}
          />
        ) : (
          <>
            {awaitsVerdict(node) && <VerdictBlock node={node} annotations={annotations} />}
            <HoldCallout node={node} />
            <GroomWithAgentCard node={node} offline={offline} />
            <DescriptionSection description={node.description} />
            <section className="flex flex-col gap-3">
              <h2 className="microlabel border-b border-line pb-1.5 text-ink-dim">
                Timeline · {feed.length}
              </h2>
              <FeedList items={feed} pending={annotationsPending} empty="Nothing yet." threaded />
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
        currentParent={node.parent}
        open={moving}
        onClose={() => setMoving(false)}
      />
    </T3LaunchSettingsHost>
  );
}

/** A verb as a More row: its label, with "…" when it asks for a reason first. */
function verbRow(
  v: VerbSpec,
  offline: boolean,
  onVerb: (v: VerbSpec) => void,
  destructive = false,
): ActionMenuAction {
  return {
    destructive,
    disabled: offline,
    key: v.verb,
    kind: 'action',
    label: v.needsReason ? `${v.label}…` : v.label,
    onSelect: () => {
      onVerb(v);
    },
  };
}

/**
 * A task's main action and More (ADR 0019, MMR-726). More groups Edit with
 * Move… and Set grooming… (until the edit sheet folds them in, MMR-731), then
 * the status changes (the T3 rows after them), then the holds, then
 * Abandon… alone, in the destructive hairline.
 */
function TaskActions({
  node,
  offline,
  onEdit,
  onMove,
  onGroom,
  onVerb,
}: {
  node: EngineNode;
  offline: boolean;
  onEdit: () => void;
  onMove: () => void;
  onGroom: () => void;
  onVerb: (v: VerbSpec) => void;
}) {
  const t3 = useT3LaunchEntries(node, offline);
  const grouped = moreVerbs(node);
  const editing: ActionMenuAction[] = [
    { disabled: offline, key: 'edit', kind: 'action', label: 'Edit', onSelect: onEdit },
    { disabled: offline, key: 'move', kind: 'action', label: 'Move…', onSelect: onMove },
    ...(visibleGrooming(node) === undefined
      ? []
      : [
          {
            disabled: offline,
            key: 'grooming',
            kind: 'action' as const,
            label: 'Set grooming…',
            onSelect: onGroom,
          },
        ]),
  ];
  const status = [...grouped.status.map((v) => verbRow(v, offline, onVerb)), ...t3];
  return (
    <>
      {mainVerbs(node).map((v, index) => (
        <ActionButton
          key={v.verb}
          size="header"
          variant={index === 0 ? 'action' : 'pageOutline'}
          disabled={offline}
          aria-haspopup={v.needsReason ? 'dialog' : undefined}
          onClick={() => {
            onVerb(v);
          }}
        >
          {mainVerbLabel(v)}
        </ActionButton>
      ))}
      <RecordMore
        title={node.title}
        recordId={node.id}
        entries={moreEntries([
          editing,
          status,
          grouped.holds.map((v) => verbRow(v, offline, onVerb)),
          grouped.abandon.map((v) => verbRow(v, offline, onVerb, true)),
        ])}
      />
    </>
  );
}
