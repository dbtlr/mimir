import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { projectsQuery, tasksQuery } from '../api/queries';
import type { TaskFilters } from '../api/queries';
import { NodeDossier } from '../components/node-dossier';
import { OfflineBanner } from '../components/offline-banner';
import { StaleBadge } from '../components/signal-badges';
import { StatusDot } from '../components/status-dot';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { tasksRoute } from '../router';

const STATUS_OPTIONS = [
  'live',
  'ready',
  'in_progress',
  'awaiting',
  'blocked',
  'parked',
  'done',
  'all',
] as const;
const SEARCH_DEBOUNCE_MS = 250;
const FIELD =
  'rounded border border-line bg-well-850 px-2 py-1 text-xs text-ink outline-none focus-visible:border-accent';

/**
 * `/tasks` — the portfolio task browser (MMR-78), sibling of `/artifacts`.
 * Filter by project + status universe and search titles; a row opens the
 * canonical node drawer (the same detail the board uses), rather than a
 * duplicated inline panel.
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
  const tasks = useQuery(tasksQuery(filters));
  const conn = connectivity([tasks]);

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

  const items = tasks.data?.items ?? [];

  return (
    <>
      <OfflineBanner {...conn} />
      <main
        className={cn(
          'mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden',
          conn.offline && 'offline-demoted',
        )}
      >
        <h1 className="flex items-baseline gap-2 px-4 pt-3">
          <span className="font-mono text-lg font-bold tracking-tight text-ink-bright">Tasks</span>
          {tasks.data !== undefined && (
            <span className="text-xs text-ink-dim">{tasks.data.total}</span>
          )}
        </h1>

        <div className="flex flex-wrap items-end gap-2 border-b border-line p-3">
          <label className="flex flex-col gap-0.5 text-tag text-ink-dim">
            Project
            <select
              value={search.project ?? ''}
              onChange={(e) => {
                setFilter({ project: e.target.value });
              }}
              className={FIELD}
            >
              <option value="">All</option>
              {(projects.data?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5 text-tag text-ink-dim">
            Status
            <select
              value={search.status ?? 'live'}
              onChange={(e) => {
                setFilter({ status: e.target.value === 'live' ? '' : e.target.value });
              }}
              className={FIELD}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-0.5 text-tag text-ink-dim">
            Search
            <input
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
              }}
              placeholder="Search titles…"
              className={FIELD}
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {tasks.isPending && <Skeleton className="m-2 h-40" />}
          {tasks.isError && tasks.data === undefined && (
            <p className="p-4 text-xs text-status-blocked">
              Unreachable — is `mimir serve` running?
            </p>
          )}
          {tasks.data !== undefined && items.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-ink-faint">No tasks match.</p>
          )}
          {items.length > 0 && (
            <ol className="flex flex-col gap-1 p-1.5">
              {items.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => {
                      openNode(node.id);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded border border-line bg-well-850 px-2.5 py-2 text-left transition-colors',
                      'hover:border-line-bright hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent',
                      search.node === node.id && 'border-line-bright bg-well-800',
                    )}
                  >
                    <StatusDot status={node.status} />
                    <span className="font-mono text-micro text-ink-dim">{node.id}</span>
                    <span className="truncate text-xs text-ink">{node.title}</span>
                    {node.verdicts?.stale === true && <StaleBadge />}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </main>
      <NodeDossier
        nodeId={search.node}
        onClose={closeNode}
        onOpenNode={openNode}
        offline={conn.offline}
      />
    </>
  );
}
