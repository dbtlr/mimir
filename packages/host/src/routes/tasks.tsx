import type { EngineNode, StatusSelector, TaskStatusWord } from '@mimir/contract';
import { STATUS_SELECTOR_VALUES } from '@mimir/contract';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { FINISHED_PAGE_SIZE, isFinishedSelection, tasksBrowserQuery } from '../api/browse-queries';
import { browserTimeZone } from '../api/queries';
import { BrowserSearch } from '../components/browser-list';
import { GroomingChip } from '../components/grooming-chip';
import { FeedCard } from '../components/patterns/feed/card';
import { CardGrid } from '../components/patterns/feed/card-grid';
import { DayFolds, FinishedRow } from '../components/patterns/feed/day-fold';
import type { FoldDay } from '../components/patterns/feed/day-fold';
import { FeedPreview } from '../components/patterns/feed/feed-preview';
import type { Preview } from '../components/patterns/feed/preview-panel';
import { Quiet } from '../components/patterns/feed/quiet';
import {
  FilterChip,
  ListGroup,
  ListPage,
  ListShowMore,
  PresetChip,
} from '../components/patterns/list-page';
import { ProjectFrame } from '../components/project-frame';
import { SizeBadge, StaleBadge } from '../components/signal-badges';
import { StatusBadge, StatusWord } from '../components/status-badge';
import { StatusDot } from '../components/status-dot';
import { TaskFilterSheet } from '../components/task-filter-sheet';
import { Skeleton } from '../components/ui/skeleton';
import { foldByDay } from '../lib/day-folds';
import { visibleGrooming } from '../lib/grooming';
import { projectKeyOf } from '../lib/project-key';
import { nodeLink } from '../lib/record-url';
import { STATUS_META, TASK_STATUS_ORDER } from '../lib/status';
import {
  PRESET_LABEL,
  bySort,
  carriedSelector,
  countLine,
  extraFilterCount,
  taskListFilters,
} from '../lib/task-list';
import { ago, relativeTime } from '../lib/time';
import { useListWindow } from '../lib/use-list-window';
import { useSearchText } from '../lib/use-search-text';
import { shippedTime } from '../lib/work-page';
import { tasksRoute } from '../router';
import type { TasksSearch } from '../router';

/** Finished rows a day shows before its Show N more. */
const FINISHED_DAY_CAP = 5;

// The chip vocabulary is the task-closed set (TASK_STATUS_ORDER, 8 words) —
// `new` is container-only, a task never carries it, and the status selector
// rejects it outright (one bad token voids the whole selection server-side).
const isTaskStatusWord = (v: string): v is TaskStatusWord =>
  (TASK_STATUS_ORDER as readonly string[]).includes(v);

/** The union universe selectors (`live`, `terminal`, `all`), which a link can carry. */
type UnionSelector = Exclude<StatusSelector, TaskStatusWord>;

const UNION_LABEL: Record<UnionSelector, string> = {
  all: 'All',
  live: 'Live',
  terminal: 'Finished',
};

const isUnionSelector = (v: string): v is UnionSelector =>
  (STATUS_SELECTOR_VALUES as readonly string[]).includes(v) && !isTaskStatusWord(v);

/** The chip's label for a status a link carries without a preset: its words and unions. */
function statusFilterLabel(status: string): string {
  const labels: string[] = [];
  for (const token of status.split(',').map((t) => t.trim())) {
    let label: string | undefined;
    if (isTaskStatusWord(token)) {
      label = STATUS_META[token].label;
    } else if (isUnionSelector(token)) {
      label = UNION_LABEL[token];
    }
    if (label !== undefined && !labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels.length > 0 ? labels.join(', ') : status;
}

const isFinished = (n: EngineNode) => n.status === 'done' || n.status === 'abandoned';

const projectKeyOfNode = (n: EngineNode) => n.home?.projectKey ?? projectKeyOf(n.id);

const seqOf = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1));

/** When a finished task finished: `done` stamps `completed_at`; an abandoned task settled when it last changed. */
const finishedAt = (n: EngineNode) => n.completedAt ?? n.updatedAt;

/**
 * The finished rows' order: the server's own paging order (MMR-460) —
 * `completedAt` descending, unset last, ties by project key then seq — so a
 * Show more window appends and never lands among shown rows.
 */
const byCompletion = (a: EngineNode, b: EngineNode) => {
  const aDone = a.completedAt?.getTime();
  const bDone = b.completedAt?.getTime();
  if (aDone !== bDone) {
    if (aDone === undefined || bDone === undefined) {
      return aDone === undefined ? 1 : -1;
    }
    return bDone - aDone;
  }
  const aKey = projectKeyOfNode(a);
  const bKey = projectKeyOfNode(b);
  if (aKey !== bKey) {
    return aKey < bKey ? -1 : 1;
  }
  return seqOf(a.id) - seqOf(b.id);
};

type TaskGroup = { key: string; label: string; items: EngineNode[] };

/** Live tasks in the list's groups: one per status present, in display order. */
function groupLive(
  items: readonly EngineNode[],
  order: (a: EngineNode, b: EngineNode) => number,
): TaskGroup[] {
  return TASK_STATUS_ORDER.map((word) => ({
    items: items.filter((n) => n.status === word).toSorted(order),
    key: word,
    label: STATUS_META[word].label,
  })).filter((g) => g.items.length > 0);
}

/** One finished task as a fold's row: its dot, title, and time; an abandoned one says so. */
function finishedRow(node: EngineNode, zone: string): ReactElement {
  const label = STATUS_META[node.status].label;
  return (
    <FinishedRow
      key={node.id}
      to={nodeLink(node.id)}
      dot={<StatusDot status={node.status} />}
      status={label}
      title={node.title}
      time={shippedTime(finishedAt(node), zone)}
      note={node.status === 'abandoned' ? <StatusWord>{label}</StatusWord> : undefined}
    />
  );
}

/**
 * Finished tasks folded by the day they finished in `zone`, newest day first,
 * rows within a day by completion. An abandoned task's day (its last change)
 * can be newer than a done one's, which `foldByDay` sorts out.
 */
function foldDays(items: readonly EngineNode[], zone: string): FoldDay[] {
  return foldByDay(items.toSorted(byCompletion), {
    at: finishedAt,
    row: (node) => finishedRow(node, zone),
    zone,
  });
}

/** A live task's card preview: its status and last move, its lede, and where it sits. */
function taskPreview(node: EngineNode): Preview {
  const facts = [
    ...(node.home?.parentTitle == null ? [] : [{ label: 'Parent', value: node.home.parentTitle }]),
    ...(node.priority == null ? [] : [{ label: 'Priority', value: node.priority }]),
    ...(node.harness == null ? [] : [{ label: 'Harness', value: node.harness }]),
    ...(node.branch == null
      ? []
      : [{ label: 'Branch', value: <span className="font-mono">{node.branch}</span> }]),
  ];
  const text = node.lede ?? node.summary;
  return {
    age: relativeTime(node.updatedAt),
    facts,
    id: node.id,
    lead: <StatusBadge status={node.status} />,
    open: nodeLink(node.id),
    reason: (
      <>
        <b>{STATUS_META[node.status].label}.</b> Last moved {ago(node.updatedAt)}.
      </>
    ),
    text: text === null || text === undefined || text === '' ? undefined : text,
    title: node.title,
  };
}

/**
 * A live task as a feed card: status, ID, and age, the title, and its size and
 * grooming chips. A task going cold demotes its title and adds the stale chip.
 */
function TaskCard({ node, goingCold }: { node: EngineNode; goingCold: boolean }) {
  // The list read sends no verdicts, so the going-cold preset says what it holds.
  const cold = goingCold || node.verdicts?.stale === true;
  const size = node.size == null ? null : <SizeBadge size={node.size} />;
  const hasChips = size !== null || cold || visibleGrooming(node) !== undefined;
  return (
    <FeedCard
      previewKey={node.id}
      lead={<StatusBadge status={node.status} />}
      id={node.id}
      age={relativeTime(node.updatedAt)}
      title={node.title}
      cold={cold}
      chips={
        hasChips && (
          <>
            {size}
            <GroomingChip node={node} />
            {cold && <StaleBadge />}
          </>
        )
      }
    />
  );
}

/**
 * `/p/KEY/tasks` — the Tasks list (ADR 0013, MMR-724 refinement; ADR 0019's
 * list page): the count line, the search, the preset as a removable chip and
 * Filter, then the tasks. Live tasks are feed cards grouped by status under
 * headings that pin while their group scrolls; finished tasks are rows folded
 * by the day they finished. Every filter is in the URL (`show`, `status`,
 * `q`, `priority`, `size`, `tag`, `sort`), so a link opens the same list; a
 * status a link carries that no Show option holds (`?status=terminal`) still
 * filters, as its own chip.
 */
export function TasksPage() {
  const navigate = useNavigate();
  const { key: project } = tasksRoute.useParams();
  const search = tasksRoute.useSearch();
  const zone = browserTimeZone();
  const filters = taskListFilters(search, { project, zone });
  const finishedOnly = isFinishedSelection(filters.status);

  const {
    read: tasks,
    shown,
    hasMore,
    loadingMore,
    loadMoreFailed,
    loadMore,
  } = useListWindow(filters, (windows) => tasksBrowserQuery(filters, windows));
  const loadedTasks = shown?.items;
  const totalTasks = shown?.total;
  const searchRef = useRef<HTMLDivElement>(null);
  const filterChip = useRef<HTMLButtonElement>(null);
  const [filtering, setFiltering] = useState(false);

  const setFilter = (partial: Partial<TasksSearch>) =>
    void navigate({
      params: { key: project },
      replace: true,
      search: (prev) => {
        const next = { ...prev, ...partial };
        for (const [k, v] of Object.entries(partial)) {
          if (v === '' || v === undefined) {
            delete (next as Record<string, unknown>)[k];
          }
        }
        return next;
      },
      to: '/p/$key/tasks',
    });

  const [q, setQ] = useSearchText(search.q, (value) => {
    setFilter({ q: value });
  });

  const sort = search.sort ?? 'recent';
  const { groups, finished, byId } = useMemo(() => {
    const items = loadedTasks ?? [];
    return {
      byId: new Map(items.map((node) => [node.id, node])),
      finished: items.filter(isFinished),
      groups: groupLive(
        items.filter((n) => !isFinished(n)),
        bySort(sort),
      ),
    };
  }, [loadedTasks, sort]);
  const days = useMemo(() => foldDays(finished, zone), [finished, zone]);
  const cards = useRef<HTMLDivElement>(null);

  // The chip for the view: the preset, or a status a link carries that no Show option holds.
  const carried = carriedSelector(search);
  let chip: { label: string; remove: Partial<TasksSearch> } | undefined;
  if (search.show !== undefined) {
    chip = { label: PRESET_LABEL[search.show], remove: { show: undefined, status: undefined } };
  } else if (carried !== undefined) {
    chip = { label: statusFilterLabel(carried), remove: { status: undefined } };
  }

  const folds = days.length > 0 && <DayFolds days={days} cap={FINISHED_DAY_CAP} />;

  return (
    <ProjectFrame projectKey={project} tab="tasks" reads={[tasks]}>
      <ListPage
        label="Tasks"
        count={
          loadedTasks !== undefined &&
          totalTasks !== undefined &&
          countLine({ show: search.show, status: search.status }, loadedTasks.length, totalTasks)
        }
        search={
          <div ref={searchRef}>
            <BrowserSearch
              value={q}
              onChange={setQ}
              label="Search tasks"
              placeholder="Search titles and IDs"
            />
          </div>
        }
        chips={
          <>
            {chip !== undefined && (
              <PresetChip
                label={chip.label}
                onRemove={() => {
                  searchRef.current?.querySelector('input')?.focus();
                  setFilter(chip.remove);
                }}
              />
            )}
            <FilterChip
              ref={filterChip}
              open={filtering}
              applied={extraFilterCount(search)}
              onClick={() => {
                setFiltering(true);
              }}
            />
          </>
        }
      >
        {tasks.isPending && loadedTasks === undefined && <Skeleton className="h-40" />}
        {tasks.isError && loadedTasks === undefined && (
          <p className="text-meta text-status-blocked-foreground">
            Unreachable — is the Mimir host running?
          </p>
        )}
        {loadedTasks !== undefined && loadedTasks.length === 0 && <Quiet>No tasks match.</Quiet>}
        {groups.length > 0 && (
          <FeedPreview
            // When a refetch drops the card that opened the preview, focus a shown card.
            fallbackFocus={() =>
              cards.current?.querySelector<HTMLElement>('[data-slot="feed-card-target"]') ?? null
            }
            preview={(key) => {
              const node = byId.get(key);
              return node === undefined || isFinished(node) ? undefined : taskPreview(node);
            }}
          >
            <div ref={cards}>
              {groups.map((group) => (
                <ListGroup key={group.key} title={group.label} count={group.items.length}>
                  <CardGrid>
                    {group.items.map((node) => (
                      <TaskCard
                        key={node.id}
                        node={node}
                        goingCold={search.show === 'going-cold'}
                      />
                    ))}
                  </CardGrid>
                </ListGroup>
              ))}
            </div>
          </FeedPreview>
        )}
        {/* A finished-only view folds straight under the chips; a mixed one heads them as a group. */}
        {folds !== false &&
          (finishedOnly ? (
            folds
          ) : (
            <ListGroup title="Finished" count={finished.length}>
              {folds}
            </ListGroup>
          ))}
        {hasMore && totalTasks !== undefined && loadedTasks !== undefined && (
          <>
            {loadMoreFailed && (
              <p role="alert" className="mt-4 text-meta text-status-blocked-foreground">
                Couldn't load more finished tasks.
              </p>
            )}
            <ListShowMore
              count={Math.min(FINISHED_PAGE_SIZE, totalTasks - loadedTasks.length)}
              noun={finishedOnly ? 'finished tasks' : 'tasks'}
              loading={loadingMore}
              onClick={loadMore}
            />
          </>
        )}
      </ListPage>
      <TaskFilterSheet
        open={filtering}
        onClose={() => {
          setFiltering(false);
        }}
        project={project}
        search={search}
        finalFocus={() => filterChip.current}
        onApply={(next) => {
          void navigate({
            params: { key: project },
            replace: true,
            search: next,
            to: '/p/$key/tasks',
          });
        }}
      />
    </ProjectFrame>
  );
}
