import type { StatusSelector, TaskStatusWord } from '@mimir/contract';
import { STATUS_SELECTOR_VALUES } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';

import { projectsQuery, taskCensusQuery, tasksQuery } from '../api/queries';
import type { TaskFilters } from '../api/queries';
import type { WireNode } from '../api/types';
import { projectKeyOf } from '../api/types';
import { NewTaskSheet } from '../components/new-task-button';
import { NodeDossier } from '../components/node-dossier';
import { OfflineBanner } from '../components/offline-banner';
import { PriorityBadge, SizeBadge } from '../components/signal-badges';
import { StatusDot } from '../components/status-dot';
import { statusChipVariants } from '../components/ui/badge';
import { MenuContent, MenuItem, MenuLabel, MenuRoot, MenuTrigger } from '../components/ui/menu';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { STATUS_META, TASK_STATUS_ORDER } from '../lib/status';
import { relativeTime } from '../lib/time';
import { tasksRoute } from '../router';

const SEARCH_DEBOUNCE_MS = 250;

/** The 17a table geometry — one grid, shared by the column-header row and every data row. */
const ROW_GRID = 'md:grid md:grid-cols-[140px_84px_minmax(0,1fr)_220px_120px_90px] md:gap-3';

/** Chip-track words shown when no status is selected; the rest fold into `+N ▾`. */
const DEFAULT_TRACK = TASK_STATUS_ORDER.slice(0, 3);

// The chip vocabulary is the task-closed set (TASK_STATUS_ORDER, 8 words) —
// `new` is container-only, a task never carries it, and the status selector
// rejects it outright (one bad token voids the whole selection server-side).
const isTaskStatusWord = (v: string): v is TaskStatusWord =>
  (TASK_STATUS_ORDER as readonly string[]).includes(v);

/** The union universe selectors (`live`, `terminal`, `all`, `archived`) — never
 * offered by the chips, but a deep link (or an old `/tasks` bookmark) can carry
 * one, and the server filters on it, so the UI must show and preserve it. */
type UnionSelector = Exclude<StatusSelector, TaskStatusWord>;

const UNION_LABEL: Record<UnionSelector, string> = {
  all: 'All',
  archived: 'Archived',
  live: 'Live',
  terminal: 'Terminal',
};

const isUnionSelector = (v: string): v is UnionSelector =>
  (STATUS_SELECTOR_VALUES as readonly string[]).includes(v) && !isTaskStatusWord(v);

/** Every valid selector in a (possibly comma-separated) `status` param, split
 * into concrete task words and union selectors. Both filter server-side and
 * both must render as active chips; invalid tokens (e.g. `new`) drop. */
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

/** The canonical `status` param: words in display order, then union selectors. */
const composeStatus = (words: readonly TaskStatusWord[], unions: readonly UnionSelector[]) =>
  [...TASK_STATUS_ORDER.filter((w) => words.includes(w)), ...unions].join(',');

/** HOME cell: mono project key › parent title, ∞ on standing (open-ended) homes. */
function HomeCell({ node }: { node: WireNode }) {
  const home = node.home;
  if (home === undefined) {
    // Facet missing (older cached payload) — the documented degraded form.
    return <span className="font-mono">{projectKeyOf(node.id)}</span>;
  }
  return (
    <>
      <span className="font-mono">{home.project_key}</span>
      {home.parent_title !== null && <> › {home.parent_title}</>}
      {home.parent_open_ended === true && (
        // role="img" + aria-label: `title` alone is unreliable AT — the glyph's
        // meaning must survive without a mouse (the OpenEndedBadge idiom, sized
        // down to table density where the literal-text badge doesn't fit).
        <span
          role="img"
          aria-label="open-ended — a standing home"
          title="open-ended — a standing home"
        >
          {' ∞'}
        </span>
      )}
    </>
  );
}

/**
 * `/tasks` — the flat portfolio task browser (mock 17a, MMR-228): every task,
 * ever, across all projects, as a dense six-column table with terminal-word
 * filters, sorted by last activity (rank deliberately absent — order means
 * nothing across projects). Rows open the canonical dossier; the filter set
 * (`q`, `project`, `status`, `node`) is URL-addressable and echoed verbatim in
 * the footer. The escape hatch from every windowed/collapsed view (G15).
 */
export function TasksPage() {
  const navigate = useNavigate();
  const search = tasksRoute.useSearch();
  const filters: TaskFilters = {};
  if (search.project !== undefined) {
    filters.project = search.project;
  }
  if (search.status !== undefined) {
    filters.status = search.status;
  }
  if (search.q !== undefined) {
    filters.q = search.q;
  }

  const projects = useQuery(projectsQuery);
  const census = useQuery(taskCensusQuery);
  const tasks = useQuery(tasksQuery(filters));
  const conn = connectivity([tasks]);
  const [createFor, setCreateFor] = useState<string | null>(null);

  const setFilter = (partial: Partial<TaskFilters>) =>
    void navigate({
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
      to: '/tasks',
    });

  const openNode = (id: string) =>
    void navigate({ search: (prev) => ({ ...prev, node: id }), to: '/tasks' });
  const closeNode = () =>
    void navigate({ search: (prev) => ({ ...prev, node: undefined }), to: '/tasks' });

  // Controlled + debounced search (the MMR-63 pattern): the box updates now, the
  // URL/query trails by the debounce; an external q change (Back/clear) re-syncs.
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => {
    setQ(search.q ?? '');
  }, [search.q]);
  const setFilterRef = useRef(setFilter);
  setFilterRef.current = setFilter;
  useEffect(() => {
    if (q === (search.q ?? '')) {
      return undefined;
    }
    const t = setTimeout(() => setFilterRef.current({ q }), SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [q, search.q]);

  // The status chip-group state: concrete selected words plus any deep-linked
  // union selectors. Toggling a word rebuilds the param from BOTH sets, so a
  // union arriving by URL is never silently discarded by a chip click.
  const { unions: statusUnions, words: statusWords } = useMemo(
    () => parseStatusSelectors(search.status),
    [search.status],
  );
  const toggleStatus = (word: TaskStatusWord) => {
    const next = statusWords.includes(word)
      ? statusWords.filter((w) => w !== word)
      : [...statusWords, word];
    setFilter({ status: composeStatus(next, statusUnions) });
  };
  const removeUnion = (union: UnionSelector) => {
    setFilter({
      status: composeStatus(
        statusWords,
        statusUnions.filter((u) => u !== union),
      ),
    });
  };
  const trackWords =
    statusWords.length > 0
      ? TASK_STATUS_ORDER.filter((w) => statusWords.includes(w))
      : DEFAULT_TRACK;
  const overflowWords = TASK_STATUS_ORDER.filter((w) => !trackWords.includes(w));

  // Last activity, newest first — the API's rank/completion order is
  // deliberately not this surface's order.
  const items = useMemo(
    () =>
      (tasks.data?.items ?? []).toSorted(
        (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
      ),
    [tasks.data],
  );

  // The canonical URL the footer echoes — the same state the URL already carries.
  const canonicalUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (search.q !== undefined) {
      p.set('q', search.q);
    }
    if (search.project !== undefined) {
      p.set('project', search.project);
    }
    if (search.status !== undefined) {
      p.set('status', search.status);
    }
    const qs = p.toString().replaceAll('%2C', ',');
    return `/tasks${qs === '' ? '' : `?${qs}`}`;
  }, [search.q, search.project, search.status]);

  return (
    <>
      <OfflineBanner {...conn} />
      <main
        className={cn(
          'flex min-h-0 w-full flex-1 flex-col overflow-hidden',
          conn.offline && 'offline-demoted',
        )}
      >
        <header className="flex flex-col gap-3 px-5 pt-[18px] pb-3">
          <div className="flex items-center gap-3">
            <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">Tasks</h1>
            {census.data !== undefined &&
              projects.data !== undefined &&
              tasks.data !== undefined && (
                <span className="text-tag text-ink-faint">
                  {census.data.total} across {projects.data.total} projects · {tasks.data.total}{' '}
                  match
                </span>
              )}
            {/* Interim create path until MMR-227's authoring sheet lands: the
                project pick IS the sheet's first step, then the create form. */}
            <MenuRoot>
              <MenuTrigger
                disabled={conn.offline}
                className="ml-auto inline-flex items-center rounded-lg bg-action px-[13px] py-1.5 text-tag font-bold text-action-foreground transition-colors hover:bg-action/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40"
              >
                + New task
              </MenuTrigger>
              <MenuContent className="w-64">
                <MenuLabel>Project</MenuLabel>
                {(projects.data?.items ?? []).map((p) => (
                  <MenuItem
                    key={p.id}
                    onClick={() => {
                      setCreateFor(p.id);
                    }}
                  >
                    <StatusDot status={p.status} />
                    <span className="font-mono text-xs font-semibold text-ink-bright">{p.id}</span>
                    <span className="truncate">{p.title}</span>
                  </MenuItem>
                ))}
              </MenuContent>
            </MenuRoot>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <label className="flex w-[280px] max-w-full items-center gap-2 rounded-[9px] border border-line-bright bg-well-950 px-3 py-2 transition-colors focus-within:border-accent">
              <span aria-hidden className="text-ink-faint">
                ⌕
              </span>
              <input
                type="search"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                }}
                aria-label="Search tasks"
                aria-describedby="tasks-search-hint"
                placeholder="Search titles…"
                className="min-w-0 flex-1 bg-transparent text-[0.78125rem] text-ink-bright caret-accent outline-none placeholder:text-ink-ghost"
              />
              <span
                id="tasks-search-hint"
                className="text-[0.625rem] whitespace-nowrap text-ink-ghost"
              >
                title substring
              </span>
            </label>

            {search.project !== undefined && (
              <button
                type="button"
                aria-label={`Remove project filter ${search.project}`}
                onClick={() => setFilter({ project: '' })}
                className="inline-flex items-center gap-1.5 rounded-full bg-accent/9 px-2.5 py-1 text-tag font-semibold text-accent-foreground inset-ring inset-ring-accent/20 transition-colors hover:bg-accent/15"
              >
                <span className="font-mono">{search.project}</span>
                <span aria-hidden>✕</span>
              </button>
            )}
            <MenuRoot>
              <MenuTrigger className="rounded-full px-2 py-1 text-tag font-semibold text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
                + project
              </MenuTrigger>
              <MenuContent className="w-56">
                {(projects.data?.items ?? []).map((p) => (
                  <MenuItem key={p.id} onClick={() => setFilter({ project: p.id })}>
                    <StatusDot status={p.status} />
                    <span className="font-mono text-xs font-semibold text-ink-bright">{p.id}</span>
                    <span className="truncate">{p.title}</span>
                  </MenuItem>
                ))}
              </MenuContent>
            </MenuRoot>

            <div
              role="group"
              aria-label="Status filter"
              className="flex flex-wrap items-center gap-1 rounded-full border border-line-bright p-[3px]"
            >
              {/* Deep-linked union selectors (live/terminal/all/archived) render as
                  active, removable chips — accent wash, not a status wash, because
                  they name a universe, not a word. */}
              {statusUnions.map((union) => (
                <button
                  key={union}
                  type="button"
                  aria-pressed
                  title={`${union} — a status union from the URL; click to remove`}
                  onClick={() => {
                    removeUnion(union);
                  }}
                  className="inline-flex items-center rounded-full bg-accent/9 px-2 py-0.5 text-tag font-semibold text-accent-foreground inset-ring inset-ring-accent/20 transition-colors hover:bg-accent/15"
                >
                  {UNION_LABEL[union]}
                </button>
              ))}
              {trackWords.map((word) => {
                const selected = statusWords.includes(word);
                return (
                  <button
                    key={word}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      toggleStatus(word);
                    }}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-tag font-semibold transition-colors',
                      selected
                        ? cn(statusChipVariants({ status: word }), 'rounded-full')
                        : 'text-ink-dim hover:text-ink',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'size-[5px] rounded-full',
                        selected ? STATUS_META[word].dot : 'bg-ink-ghost',
                      )}
                    />
                    {STATUS_META[word].label}
                  </button>
                );
              })}
              {overflowWords.length > 0 && (
                <MenuRoot>
                  <MenuTrigger className="rounded-full px-2 py-0.5 text-tag text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
                    +{overflowWords.length} ▾
                  </MenuTrigger>
                  <MenuContent>
                    {overflowWords.map((word) => (
                      <MenuItem
                        key={word}
                        onClick={() => {
                          toggleStatus(word);
                        }}
                      >
                        <StatusDot status={word} />
                        {STATUS_META[word].label}
                      </MenuItem>
                    ))}
                  </MenuContent>
                </MenuRoot>
              )}
            </div>

            <span className="ml-auto hidden text-tag text-ink-ghost lg:block">
              sorted by last activity · URL-addressable
            </span>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tasks.isPending && <Skeleton className="m-4 h-40" />}
          {tasks.isError && tasks.data === undefined && (
            <p className="p-4 text-xs text-status-blocked">
              Unreachable — is `mimir serve` running?
            </p>
          )}
          {tasks.data !== undefined && items.length === 0 && (
            <p className="px-4 py-10 text-center text-xs text-ink-faint">No tasks match.</p>
          )}
          {items.length > 0 && (
            <div role="table" aria-label="Tasks">
              {/* Below md the header row hides *visually only* (sr-only, not
                  display:none) so the columnheader↔cell association survives
                  in the accessibility tree at every width. */}
              <div role="rowgroup" className="max-md:sr-only">
                <div
                  role="row"
                  className={cn(
                    'sticky top-0 z-10 border-b border-line bg-well-900 px-5 py-2',
                    ROW_GRID,
                  )}
                >
                  {(['STATUS', 'ID', 'TITLE', 'HOME', 'SIGNALS', 'ACTIVITY'] as const).map((h) => (
                    <span
                      key={h}
                      role="columnheader"
                      className={cn(
                        'font-mono text-[0.625rem] tracking-[0.12em] text-ink-ghost',
                        h === 'ACTIVITY' && 'text-right',
                      )}
                    >
                      {h}
                    </span>
                  ))}
                </div>
              </div>
              <div role="rowgroup">
                {items.map((node) => {
                  // Terminal rows demote by ink tier alone — never by opacity
                  // (ADR 0019 §7; opacity is offline's), and never by a row
                  // ground: rows sit on the page well, where `well-recessed`
                  // (defined against the card ground) reads RAISED in both
                  // themes (the trap skeleton.tsx documents).
                  const demoted = node.status === 'done' || node.status === 'abandoned';
                  const meta = STATUS_META[node.status];
                  return (
                    <button
                      key={node.id}
                      type="button"
                      // The whole row is the hit target AND the grid row: a native
                      // button keeps focus/keyboard semantics while role="row" keeps
                      // the columnheader↔cell association (the 17a a11y contract).
                      // oxlint-disable-next-line jsx-a11y/no-interactive-element-to-noninteractive-role
                      role="row"
                      aria-label={`${meta.label} ${node.id} ${node.title}`}
                      aria-current={search.node === node.id ? 'true' : undefined}
                      onClick={() => {
                        openNode(node.id);
                      }}
                      className={cn(
                        'flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/50 px-5 py-[11px] text-left transition-colors md:min-h-0',
                        ROW_GRID,
                        'hover:bg-well-850 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                        node.status === 'under_review' && 'bg-attention/3',
                        search.node === node.id && 'bg-well-800 inset-ring inset-ring-line-bright',
                      )}
                    >
                      <span role="cell" className="flex items-center gap-2">
                        <StatusDot status={node.status} className="size-1.5" />
                        <span
                          className={cn(
                            'font-mono text-micro tracking-[0.08em] whitespace-nowrap uppercase',
                            // The abandoned foreground token fails AA as text at
                            // this size in both themes (~1.9:1 dark / ~3.4:1
                            // light on the page well); the word must stay
                            // legible — it is the status carrier for the
                            // color-blind case. ink-dim passes in both themes;
                            // the dot keeps the status hue.
                            node.status === 'abandoned' ? 'text-ink-dim' : meta.foreground,
                          )}
                        >
                          {meta.label}
                        </span>
                      </span>
                      {/* Metadata cells stay at the ink-faint baseline even when
                          demoted — the ghost tier drops below ~2.6:1 on the page
                          well; the demotion reads from the title + STATUS word. */}
                      <span role="cell" className="font-mono text-mono-id text-ink-faint">
                        {node.id}
                      </span>
                      <span
                        role="cell"
                        className={cn(
                          'truncate text-body font-medium max-md:w-full',
                          demoted ? 'text-ink-dim' : 'text-ink-bright',
                          node.status === 'abandoned' && 'line-through decoration-ink-ghost',
                        )}
                      >
                        {node.title}
                      </span>
                      <span role="cell" className="truncate text-mono-id text-ink-faint">
                        <HomeCell node={node} />
                      </span>
                      <span role="cell" className="flex items-center gap-1">
                        {node.priority !== undefined && node.priority !== null && (
                          <PriorityBadge priority={node.priority} />
                        )}
                        {node.size !== undefined && node.size !== null && (
                          <SizeBadge size={node.size} />
                        )}
                      </span>
                      <span role="cell" className="text-mono-id text-ink-faint md:text-right">
                        {relativeTime(node.updated_at)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3">
          {tasks.data !== undefined && (
            <span className="text-tag text-ink-ghost">
              {tasks.data.total} matches · {items.length} shown
            </span>
          )}
          <span className="ml-auto truncate font-mono text-micro text-ink-ghost">
            {canonicalUrl}
          </span>
        </footer>
      </main>

      {createFor !== null && (
        <NewTaskSheet
          projectKey={createFor}
          open
          onOpenChange={(open) => {
            if (!open) {
              setCreateFor(null);
            }
          }}
        />
      )}
      <NodeDossier
        nodeId={search.node}
        onClose={closeNode}
        onOpenNode={openNode}
        offline={conn.offline}
      />
    </>
  );
}
