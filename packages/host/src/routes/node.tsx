import type { EngineNode, EngineTree } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import type { Ref } from 'react';

import { isNotFound } from '../api/errors';
import { annotationsQuery, nodeQuery, scratchpadsQuery } from '../api/node-queries';
import { treeQuery } from '../api/shell-queries';
import { GroomingBadge } from '../components/grooming-chip';
import { mainVerbLabel, mainVerbs, moreVerbs, useNodeVerbs } from '../components/node-record';
import { RecordTimeline } from '../components/node-timeline';
import { OfflineBanner } from '../components/offline-banner';
import type { ActionMenuAction } from '../components/patterns/action-menu';
import { RecordHeader } from '../components/patterns/record-header';
import { RecordTabs } from '../components/patterns/record-tabs';
import { RECORD_TYPE_LABEL, RecordMore, moreEntries, recordTrail } from '../components/record-head';
import { RecordPending } from '../components/record-layout';
import { StatusBadge } from '../components/status-badge';
import {
  T3LaunchSettingsHost,
  canLaunchOnT3,
  useT3LaunchEntries,
} from '../components/t3-launch-control';
import { TaskEditSheet } from '../components/task-edit-sheet';
import { TaskDetails, TaskWork } from '../components/task-page';
import type { ScratchpadRow } from '../components/task-page';
import { ActionButton } from '../components/ui/action-button';
import {
  ArtifactsTab,
  ContainerPage,
  RecordColumn,
  recordTabs,
  useShownTab,
} from '../components/work-page';
import type { OpenTab, RecordPageTabs } from '../components/work-page';
import { connectivity } from '../lib/connectivity';
import { visibleGrooming } from '../lib/grooming';
import { projectKeyOf } from '../lib/project-key';
import { useRememberRecord } from '../lib/recent-records';
import { nodeIdOf } from '../lib/record-url';
import { buildFeed } from '../lib/timeline';
import type { NodeAnnotation } from '../lib/timeline';
import type { VerbSpec } from '../lib/transitions';
import { nodeRoute } from '../router';
import { NotFoundPage } from './not-found';

/**
 * `/p/$key/$seq` — a work node's own page (ADR 0013, v0.23 refinement). The
 * path is the node id split at its hyphen; a suffix that is not a node's shows
 * the not-found state without a lookup. Every node opens under the record
 * header (MMR-726) with its tabs in the one page column: an initiative or
 * phase as the work page, a task on Work, Details, Timeline, and Artifacts
 * (MMR-728). Each keeps its notes on the record timeline, behind Timeline.
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
  const onTab: OpenTab = (next, options) => {
    void navigate({
      replace: options?.replace,
      search: { tab: next === 'work' ? undefined : next },
    });
  };
  const tabs: RecordPageTabs = {
    onTab,
    recordReadAt: node.dataUpdatedAt,
    since: mountedAt,
    tab,
    timeline: (
      <RecordTimeline
        items={feed}
        pending={annotations.isPending}
        nodeId={nodeId}
        offline={offline}
      />
    ),
    timelineCount: feed.length,
  };

  // An initiative or phase opens as the work page (MMR-467 and MMR-726
  // refinements), its tabs selected by the URL.
  if (data.type !== 'task') {
    return (
      <>
        <OfflineBanner {...conn} />
        <ContainerPage record={data} tree={tree.data} offline={offline} container={tabs} />
      </>
    );
  }

  return (
    <>
      <OfflineBanner {...conn} />
      <TaskRecord
        node={data}
        tree={tree.data}
        annotations={annotations.data?.items ?? []}
        scratchpads={(scratchpadRows.data ?? []).filter((s) => s.linkedWork.includes(nodeId))}
        offline={offline}
        tabs={tabs}
      />
    </>
  );
}

/**
 * A task's page (ADR 0013, MMR-726 and MMR-728 refinements): the record
 * header, with the state's main action and More, over its tabs in the one
 * page column. Work is the default; Details holds the facts, Timeline the
 * record timeline, and Artifacts shows once one is attached. More's Edit opens
 * the edit sheet over the page (MMR-731).
 */
function TaskRecord({
  node,
  tree,
  annotations,
  scratchpads,
  offline,
  tabs: page,
}: {
  node: EngineNode;
  tree: EngineTree | undefined;
  annotations: readonly NodeAnnotation[];
  scratchpads: readonly ScratchpadRow[];
  offline: boolean;
  tabs: RecordPageTabs;
}) {
  const nodeId = node.id;
  const projectKey = projectKeyOf(nodeId);
  const verbs = useNodeVerbs(nodeId);
  const [editing, setEditing] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const launchEligible = canLaunchOnT3(node);
  const groomingState = visibleGrooming(node);
  const tabs = recordTabs(node, page.timelineCount, true);
  const tab = useShownTab(tabs, page.tab, page.recordReadAt >= page.since, page.onTab);

  return (
    // Launch in T3's settings form lives above More, so it outlives the menu that opened it.
    <T3LaunchSettingsHost eligible={launchEligible}>
      <RecordColumn offline={offline}>
        <RecordHeader
          trail={recordTrail(projectKey, tree, nodeId)}
          title={node.title}
          status={<StatusBadge status={node.status} />}
          type={RECORD_TYPE_LABEL.task}
          recordId={nodeId}
          summary={node.summary}
          chips={groomingState === undefined ? undefined : <GroomingBadge state={groomingState} />}
          actions={
            <TaskActions
              node={node}
              offline={offline}
              moreRef={more}
              onEdit={() => {
                setEditing(true);
              }}
              onVerb={verbs.handleVerb}
            />
          }
        />
        <RecordTabs
          tabs={tabs}
          value={tab}
          onSelect={(next) => {
            page.onTab(next);
          }}
        >
          {tab === 'work' && <TaskWork node={node} annotations={annotations} offline={offline} />}
          {tab === 'details' && <TaskDetails node={node} tree={tree} scratchpads={scratchpads} />}
          {tab === 'timeline' && page.timeline}
          {tab === 'artifacts' && <ArtifactsTab record={node} />}
        </RecordTabs>
      </RecordColumn>
      {verbs.dialog}
      <TaskEditSheet
        node={node}
        tree={tree}
        open={editing}
        finalFocus={() => more.current}
        onClose={() => {
          setEditing(false);
        }}
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
 * A task's main action and More (ADR 0019, MMR-726). More leads with Edit,
 * which opens the edit sheet (MMR-731), then the status changes (the T3 rows
 * after them), then the holds, then Abandon… alone, in the destructive
 * hairline.
 */
function TaskActions({
  node,
  offline,
  moreRef,
  onEdit,
  onVerb,
}: {
  node: EngineNode;
  offline: boolean;
  /** More's button, where focus returns when the edit sheet closes. */
  moreRef: Ref<HTMLButtonElement>;
  onEdit: () => void;
  onVerb: (v: VerbSpec) => void;
}) {
  const t3 = useT3LaunchEntries(node, offline);
  const grouped = moreVerbs(node);
  const editing: ActionMenuAction[] = [
    { disabled: offline, key: 'edit', kind: 'action', label: 'Edit', onSelect: onEdit },
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
        triggerRef={moreRef}
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
