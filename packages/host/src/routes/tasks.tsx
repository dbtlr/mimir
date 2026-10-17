import type { StatusSelector, TaskStatusWord } from '@mimir/contract';
import { STATUS_SELECTOR_VALUES } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

import { tasksBrowserQuery } from '../api/queries';
import type { TaskFilters } from '../api/queries';
import type { Collection, WireNode } from '../api/types';
import { projectKeyOf } from '../api/types';
import { AuthoringSheet } from '../components/authoring-sheet';
import {
  BrowserEmpty,
  BrowserGroup,
  BrowserPage,
  BrowserRow,
  BrowserSearch,
  BrowserShowMore,
  FilterChip,
  FilterRow,
  RemovableChip,
} from '../components/browser-list';
import { GroomingChip } from '../components/grooming-chip';
import { OfflineBanner } from '../components/offline-banner';
import { ProjectGate } from '../components/project-gate';
import { StatusDot } from '../components/status-dot';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { nodeLink } from '../lib/record-url';
import { STATUS_META, TASK_STATUS_ORDER } from '../lib/status';
import { relativeTime } from '../lib/time';
import { tasksRoute } from '../router';
import type { TasksSearch } from '../router';

const SEARCH_DEBOUNCE_MS = 250;

// The chip vocabulary is the task-closed set (TASK_STATUS_ORDER, 8 words) —
// `new` is container-only, a task never carries it, and the status selector
// rejects it outright (one bad token voids the whole selection server-side).
const isTaskStatusWord = (v: string): v is TaskStatusWord =>
  (TASK_STATUS_ORDER as readonly string[]).includes(v);

/** The union universe selectors (`live`, `terminal`, `all`). `live` and
 * `terminal` back the Live and Finished chips; a deep link can carry any of
 * them (or a word), and the server filters on it, so the UI must show it. */
type UnionSelector = Exclude<StatusSelector, TaskStatusWord>;

const UNION_LABEL: Record<UnionSelector, string> = {
  all: 'All',
  live: 'Live',
  terminal: 'Finished',
};

const isUnionSelector = (v: string): v is UnionSelector =>
  (STATUS_SELECTOR_VALUES as readonly string[]).includes(v) && !isTaskStatusWord(v);

/** Every valid selector in a (possibly comma-separated) `status` param, split
 * into concrete task words and union selectors. Both filter server-side;
 * invalid tokens (e.g. `new`) drop. */
function parseStatusSelectors(status: string | undefined): {
  words: TaskStatusWord[];
  unions: UnionSelector[];
} {
  const words: TaskStatusWord[] = [];
  const unions: UnionSelector[] = [];
  for (const token of (status ?? '').split(',').map((t) => t.trim())) {
    if (isTaskStatusWord(token) && !words.includes(token)) {
      words.push(token);
    } else if (isUnionSelector(token) && !unions.includes(token)) {
      unions.push(token);
    }
  }
  return { unions, words };
}

/** The removable chip's label for a status the Live/Finished chips don't own. */
function statusFilterLabel(status: string): string {
  const { unions, words } = parseStatusSelectors(status);
  const labels = [...words.map((w) => STATUS_META[w].label), ...unions.map((u) => UNION_LABEL[u])];
  return labels.length > 0 ? labels.join(', ') : status;
}

/** Live is the default view: no `status` param, or `live` spelled out. */
const isLiveView = (status: string | undefined) => status === undefined || status === 'live';

type TaskGroup = { key: string; label: string; items: WireNode[] };

const newestFirst = (a: WireNode, b: WireNode) =>
  Date.parse(b.updated_at) - Date.parse(a.updated_at);

const projectKeyOfNode = (n: WireNode) => n.home?.project_key ?? projectKeyOf(n.id);

/**
 * The Finished view's row order: the server's own paging order (MMR-460) —
 * `completed_at` descending, unset last, ties by project key then seq — so a
 * "Show more" window appends to each group and never lands among shown rows.
 */
const byCompletion = (a: WireNode, b: WireNode) => {
  const aDone = a.completed_at ?? '';
  const bDone = b.completed_at ?? '';
  if (aDone !== bDone) {
    if (aDone === '' || bDone === '') {
      return aDone === '' ? 1 : -1;
    }
    return aDone < bDone ? 1 : -1;
  }
  const aKey = projectKeyOfNode(a);
  const bKey = projectKeyOfNode(b);
  if (aKey !== bKey) {
    return aKey < bKey ? -1 : 1;
  }
  return seqOf(a.id) - seqOf(b.id);
};

const seqOf = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1));

/**
 * Bucket tasks into the browser's groups: one per status word present, in
 * display order. Rows within a group follow `order` (newest activity first
 * unless a view says otherwise); empty groups never appear.
 */
function groupTasks(
  items: readonly WireNode[],
  order: (a: WireNode, b: WireNode) => number,
): TaskGroup[] {
  return TASK_STATUS_ORDER.map((word) => ({
    items: items.filter((n) => n.status === word).toSorted(order),
    key: word,
    label: STATUS_META[word].label,
  })).filter((g) => g.items.length > 0);
}

/** The meta line: mono project key › parent title, ∞ on a standing home, then the age. */
function TaskMeta({ node }: { node: WireNode }) {
  const home = node.home;
  return (
    <>
      <span className="font-mono">{home?.project_key ?? projectKeyOf(node.id)}</span>
      {home?.parent_title != null && <> › {home.parent_title}</>}
      {home?.parent_open_ended === true && (
        // role="img" + aria-label: `title` alone is unreliable AT — the glyph's
        // meaning must survive without a mouse. relative z-10 lifts it above the
        // row's stretched link, so its tooltip still shows on hover.
        <span
          role="img"
          aria-label="open-ended — a standing home"
          title="open-ended — a standing home"
          className="relative z-10"
        >
          {' ∞'}
        </span>
      )}
      {' · '}
      {relativeTime(node.updated_at)}
    </>
  );
}

/**
 * The browser's task read with its Show more window (MMR-460). `windows`
 * grows on each "Show more" and resets whenever the filters change; the
 * query refetches the larger prefix, keeping the shown rows meanwhile. If
 * that larger read fails the last good rows stay on screen and the failure
 * is reported beside the button, which retries it.
 */
function useTaskWindow(filters: TaskFilters) {
  const scope = JSON.stringify(filters);
  const [grown, setGrown] = useState({ scope, windows: 1 });
  // A filter change starts over at one window (reset during render, so the
  // stale window count never reaches a query).
  if (grown.scope !== scope) {
    setGrown({ scope, windows: 1 });
  }
  const windows = grown.scope === scope ? grown.windows : 1;
  const tasks = useQuery(tasksBrowserQuery(filters, windows));

  // The last settled result for these filters, so a failed larger read does
  // not blank the list (an errored query without data has none of its own).
  const [kept, setKept] = useState<{ scope: string; data: Collection<WireNode> }>();
  if (
    tasks.data !== undefined &&
    !tasks.isPlaceholderData &&
    (kept?.scope !== scope || kept.data !== tasks.data)
  ) {
    setKept({ data: tasks.data, scope });
  }
  const shown = tasks.data ?? (kept?.scope === scope ? kept.data : undefined);

  return {
    hasMore: shown !== undefined && shown.items.length < shown.total,
    loadMore: () => {
      if (tasks.isError) {
        void tasks.refetch();
      } else {
        setGrown({ scope, windows: windows + 1 });
      }
    },
    loadMoreFailed: tasks.isError && tasks.data === undefined && shown !== undefined,
    loadedTasks: shown?.items,
    loadingMore: tasks.isPlaceholderData,
    tasks,
    totalTasks: shown?.total,
  };
}

/**
 * `/p/KEY/tasks` — the grouped reading list (MMR-454, mock "Browsers C"): every
 * task in the path's project, grouped by status, each row a real
 * link with its lede and where it lives. Live is the default view; the filter
 * set (`q`, `status`) is URL-addressable, so the browser stays the
 * complete view (ADR 0013) — any status a deep link carries still filters and
 * shows as a removable chip.
 */
export function TasksPage() {
  const navigate = useNavigate();
  const { key: project } = tasksRoute.useParams();
  const search = tasksRoute.useSearch();
  const liveView = isLiveView(search.status);
  const finishedView = search.status === 'terminal';
  const filters: TaskFilters = { lede: true, project };
  // Live is the default view, so a URL with no status asks for it explicitly
  // rather than leaning on the server's default.
  filters.status = search.status ?? 'live';
  if (search.q !== undefined) {
    filters.q = search.q;
  }

  const { tasks, loadedTasks, totalTasks, hasMore, loadingMore, loadMoreFailed, loadMore } =
    useTaskWindow(filters);
  const conn = connectivity([tasks]);
  const [createOpen, setCreateOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

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

  // Controlled + debounced search (the MMR-63 pattern): the box updates now, the
  // URL/query trails by the debounce; an external q change (Back/clear) re-syncs
  // during render.
  const [q, setQ] = useState(search.q ?? '');
  const [syncedQ, setSyncedQ] = useState(search.q);
  if (search.q !== syncedQ) {
    setSyncedQ(search.q);
    setQ(search.q ?? '');
  }
  const pushQ = useEffectEvent((value: string) => {
    setFilter({ q: value });
  });
  useEffect(() => {
    if (q === (search.q ?? '')) {
      return undefined;
    }
    const t = setTimeout(() => {
      pushQ(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [q, search.q]);

  const groups = useMemo(
    () => groupTasks(loadedTasks ?? [], finishedView ? byCompletion : newestFirst),
    [loadedTasks, finishedView],
  );

  let countWord = 'match';
  if (liveView) {
    countWord = 'live';
  } else if (finishedView) {
    countWord = 'finished';
  }

  return (
    <ProjectGate projectKey={project}>
      <>
        <OfflineBanner {...conn} />
        <main
          className={cn('min-h-0 w-full flex-1 overflow-y-auto', conn.offline && 'offline-demoted')}
        >
          <BrowserPage
            title="Tasks"
            count={
              loadedTasks !== undefined &&
              totalTasks !== undefined &&
              // A windowed view says how much of the whole it shows (MMR-460).
              `${loadedTasks.length < totalTasks ? `${loadedTasks.length} of ` : ''}${totalTasks} ${countWord}`
            }
            action={
              // Create opens the shared authoring sheet (MMR-227), whose own
              // project-spanning HOME picker chooses where the node lands.
              <button
                type="button"
                disabled={conn.offline}
                onClick={() => {
                  setCreateOpen(true);
                }}
                className="inline-flex items-center rounded-lg bg-action px-[13px] py-1.5 text-tag font-bold text-action-foreground transition-colors hover:bg-action/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40"
              >
                + New task
              </button>
            }
          >
            <FilterRow>
              <div ref={searchRef} className="flex min-w-0 flex-[1_1_260px]">
                <BrowserSearch
                  value={q}
                  onChange={setQ}
                  label="Search tasks"
                  placeholder="Search titles and IDs…"
                />
              </div>
              <FilterChip
                on={liveView}
                onClick={() => {
                  setFilter({ status: '' });
                }}
              >
                Live
              </FilterChip>
              <FilterChip
                on={finishedView}
                onClick={() => {
                  setFilter({ status: 'terminal' });
                }}
              >
                Finished
              </FilterChip>
              {/* Any other status a deep link carries (a word, a union, `all`)
                still filters; it shows as an accent chip that removes it. */}
              {!liveView && !finishedView && search.status !== undefined && (
                <RemovableChip
                  label={statusFilterLabel(search.status)}
                  removeLabel={`Remove status filter ${statusFilterLabel(search.status)}`}
                  onRemove={() => {
                    searchRef.current?.querySelector('input')?.focus();
                    setFilter({ status: '' });
                  }}
                />
              )}
            </FilterRow>

            {tasks.isPending && loadedTasks === undefined && <Skeleton className="mt-4 h-40" />}
            {tasks.isError && loadedTasks === undefined && (
              <p className="py-4 text-xs text-status-blocked">
                Unreachable — is the Mimir host running?
              </p>
            )}
            {loadedTasks !== undefined && groups.length === 0 && (
              <BrowserEmpty>No tasks match.</BrowserEmpty>
            )}
            {groups.map((group) => (
              <BrowserGroup key={group.key} label={group.label} count={group.items.length}>
                {group.items.map((node) => (
                  <BrowserRow
                    key={node.id}
                    to={nodeLink(node.id)}
                    id={node.id}
                    title={node.title}
                    leading={
                      <>
                        <StatusDot status={node.status} />
                        <span className="sr-only">{STATUS_META[node.status].label}</span>
                      </>
                    }
                    afterTitle={<GroomingChip node={node} />}
                    lede={node.lede ?? node.summary}
                    meta={<TaskMeta node={node} />}
                    // Terminal rows demote by ink tier alone — never by opacity
                    // (ADR 0019 §7; opacity is offline's).
                    demoted={node.status === 'done' || node.status === 'abandoned'}
                    struck={node.status === 'abandoned'}
                  />
                ))}
              </BrowserGroup>
            ))}
            {hasMore && (
              <>
                {loadMoreFailed && (
                  <p role="alert" className="mt-4 text-center text-xs text-status-blocked">
                    Couldn't load more finished tasks.
                  </p>
                )}
                <BrowserShowMore loading={loadingMore} onClick={loadMore} />
              </>
            )}
          </BrowserPage>
        </main>

        <AuthoringSheet open={createOpen} onOpenChange={setCreateOpen} offline={conn.offline} />
      </>
    </ProjectGate>
  );
}
