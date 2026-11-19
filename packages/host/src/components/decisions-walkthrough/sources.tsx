import type { EngineTree } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { treeQuery } from '../../api/shell-queries';
import { deliveryPageQuery, workQuery } from '../../api/view-queries';
import { connectivity } from '../../lib/connectivity';
import { useBackToOpener, useOpenerMark } from '../../lib/walkthrough-mark';
import { DecisionsWalkthrough } from './walkthrough';
import type { WalkRead } from './walkthrough';

/** Every node's title by id, down the tree. */
function treeTitles(root: EngineTree | undefined): Map<string, string> {
  const titles = new Map<string, string>();
  const visit = (node: EngineTree) => {
    titles.set(node.id, node.title);
    node.children.forEach(visit);
  };
  if (root !== undefined) {
    visit(root);
  }
  return titles;
}

/**
 * Closing leaves the mode. A walkthrough an entry opened goes back one
 * history entry and focuses that entry; any other replaces its entry with
 * the page without the mode.
 */
function useLeaveMode() {
  const navigate = useNavigate();
  const back = useBackToOpener();
  const mark = useOpenerMark();
  return () => {
    if (mark !== undefined) {
      back(mark);
    } else {
      void navigate({ replace: true, search: {}, to: '.' });
    }
  };
}

/**
 * `?mode=decisions` on a delivery page: the walkthrough of the delivery's
 * provisional decisions, titled from the delivery's members. Its own
 * observer, so opening refetches a read gone stale.
 */
export function DeliveryDecisions({ id }: { id: string }) {
  const query = useQuery(deliveryPageQuery(id));
  const leave = useLeaveMode();
  const data = query.data;
  const read: WalkRead = {
    conn: connectivity([query]),
    decisions: data?.decisions,
    failed: data === undefined && query.isError,
    settled: !query.isStale || query.isError || query.isPaused,
    titles: new Map(data?.members.map((member) => [member.id, member.title])),
  };
  return (
    <DecisionsWalkthrough
      scope={{ id, kind: 'delivery', title: data?.delivery.title ?? id }}
      read={read}
      onClose={leave}
    />
  );
}

/**
 * `?mode=decisions` on a project's page: the walkthrough of the project's
 * provisional decisions that name no delivery, from its Needs you read and
 * titled from its tree.
 */
export function ProjectDecisions({ projectKey }: { projectKey: string }) {
  const work = useQuery(workQuery({ key: projectKey, kind: 'project' }));
  const tree = useQuery(treeQuery(projectKey));
  const leave = useLeaveMode();
  const read: WalkRead = {
    conn: connectivity([work]),
    decisions: work.data?.needsYou.flatMap((row) =>
      row.kind === 'decision' && row.decision.delivery === null ? [row.decision] : [],
    ),
    failed: work.data === undefined && work.isError,
    settled: !work.isStale || work.isError || work.isPaused,
    titles: treeTitles(tree.data),
  };
  return (
    <DecisionsWalkthrough
      scope={{ key: projectKey, kind: 'project' }}
      read={read}
      onClose={leave}
    />
  );
}
