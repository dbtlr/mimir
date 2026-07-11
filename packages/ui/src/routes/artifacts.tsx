import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { UIEvent } from 'react';

import { artifactsQuery, projectsQuery } from '../api/queries';
import type { ArtifactFilters as Filters } from '../api/queries';
import { projectKeyOf } from '../api/types';
import { ArtifactFilters } from '../components/artifact-filters';
import { ArtifactList } from '../components/artifact-list';
import { ArtifactReader } from '../components/artifact-reader';
import { OfflineBanner } from '../components/offline-banner';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { artifactsRoute } from '../router';

const FILTER_KEYS = ['project', 'tag', 'q', 'since', 'before'] as const;

/**
 * `/artifacts` — the portfolio artifact browser (Meridian 16a/16b): a 360px
 * master column (search, filter chips, date-grouped rows) beside the frozen
 * reader; below `md` the two panes are mutually exclusive.
 */
export function ArtifactsPage() {
  const navigate = useNavigate();
  const search = artifactsRoute.useSearch();
  const filters: Filters = {};
  for (const k of FILTER_KEYS) {
    if (search[k] !== undefined) {
      filters[k] = search[k];
    }
  }

  const projects = useQuery(projectsQuery);
  const artifacts = useInfiniteQuery(artifactsQuery(filters));
  const conn = connectivity([projects, artifacts]);

  const rows = artifacts.data?.pages.flatMap((page) => page.items);
  const total = artifacts.data?.pages.at(-1)?.total;

  // The footer's "scroll for more": nearing the bottom pulls the next window.
  const onListScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 200;
    if (nearBottom && artifacts.hasNextPage && !artifacts.isFetchingNextPage) {
      void artifacts.fetchNextPage();
    }
  };

  // `replace` so a filter edit replaces the current history entry rather than
  // pushing one per keystroke (Back should leave the browser, not unwind typing).
  const setFilter = (partial: Partial<Filters>) =>
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
      to: '/artifacts',
    });

  const select = (id: string) =>
    void navigate({ search: (prev) => ({ ...prev, a: id }), to: '/artifacts' });

  const back = () => {
    if (search.from !== undefined) {
      const from = search.from;
      void navigate({
        params: { key: projectKeyOf(from) },
        search: { node: from, view: 'board' },
        to: '/p/$key',
      });
    } else {
      void navigate({
        search: (prev) => ({ ...prev, a: undefined, from: undefined }),
        to: '/artifacts',
      });
    }
  };

  const openNode = (nodeId: string) =>
    void navigate({
      params: { key: projectKeyOf(nodeId) },
      search: { node: nodeId, view: 'board' },
      to: '/p/$key',
    });

  const openProject = (key: string) =>
    void navigate({ params: { key }, search: { view: 'board' }, to: '/p/$key' });

  const selected = search.a;

  return (
    <>
      <OfflineBanner {...conn} />
      <main className={cn('flex min-h-0 flex-1', conn.offline && 'offline-demoted')}>
        <div
          className={cn(
            'min-h-0 w-full flex-col border-line bg-well-950 md:flex md:w-90 md:shrink-0 md:border-r',
            selected !== undefined ? 'hidden' : 'flex',
          )}
        >
          <header className="flex items-center gap-2.5 px-4 pt-4 pb-2.5">
            <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">Artifacts</h1>
            {total !== undefined && (
              <span className="ml-auto text-tag text-ink-faint">{total} frozen</span>
            )}
          </header>

          <ArtifactFilters
            filters={filters}
            projects={(projects.data?.items ?? []).map((p) => p.id)}
            onChange={setFilter}
          />

          <div
            className="min-h-0 flex-1 overflow-auto"
            data-testid="artifact-scroll"
            onScroll={onListScroll}
          >
            {artifacts.isPending && <Skeleton className="m-2 h-40" />}
            {rows !== undefined && (
              <ArtifactList items={rows} selectedId={selected} onSelect={select} />
            )}
            {artifacts.isFetchingNextPage && <Skeleton className="m-2 h-10" />}
            {artifacts.isError && artifacts.data === undefined && (
              <p className="p-4 text-xs text-status-blocked">
                Unreachable — is `mimir serve` running?
              </p>
            )}
          </div>

          <footer className="border-t border-line px-4 py-2 text-tag text-ink-ghost">
            newest first · windowed, scroll for more
          </footer>
        </div>

        <div
          className={cn(
            'min-h-0 flex-1 flex-col bg-well-900',
            selected !== undefined ? 'flex' : 'hidden md:flex',
          )}
        >
          {selected !== undefined ? (
            <ArtifactReader
              id={selected}
              fromNode={search.from}
              onBack={back}
              onOpenNode={openNode}
              onOpenProject={openProject}
            />
          ) : (
            <p className="hidden w-full items-center justify-center p-8 text-xs text-ink-faint md:flex">
              Select an artifact to read.
            </p>
          )}
        </div>
      </main>
    </>
  );
}
