import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { UIEvent } from 'react';

import { artifactsQuery, projectsQuery } from '../api/queries';
import type { ArtifactFilters as Filters } from '../api/queries';
import { ArtifactFilters } from '../components/artifact-filters';
import { ArtifactList } from '../components/artifact-list';
import { BrowserPage } from '../components/browser-list';
import { OfflineBanner } from '../components/offline-banner';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { artifactsRoute } from '../router';

const FILTER_KEYS = ['project', 'tag', 'q', 'atOrAfter', 'atOrBefore'] as const;

/**
 * `/artifacts` — the portfolio artifact browser (MMR-454, "Browsers C"): one
 * centred column of frozen artifacts grouped by day, newest first. Every row
 * links to the artifact's own page; the page scrolls within the shell and
 * nearing the bottom pulls the next window.
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

  // Nearing the bottom pulls the next window.
  const onScroll = (e: UIEvent<HTMLElement>) => {
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

  return (
    <>
      <OfflineBanner {...conn} />
      <main
        className={cn('min-h-0 w-full flex-1 overflow-y-auto', conn.offline && 'offline-demoted')}
        data-testid="artifact-scroll"
        onScroll={onScroll}
      >
        <BrowserPage title="Artifacts" count={total === undefined ? undefined : `${total} frozen`}>
          <ArtifactFilters
            filters={filters}
            projects={(projects.data?.items ?? []).map((p) => p.id)}
            rowTags={(rows ?? []).map((a) => a.tags)}
            onChange={setFilter}
          />
          {artifacts.isPending && <Skeleton className="mt-4 h-40" />}
          {rows !== undefined && <ArtifactList items={rows} />}
          {artifacts.isFetchingNextPage && <Skeleton className="mt-2 h-10" />}
          {artifacts.isError && artifacts.data === undefined && (
            <p className="py-4 text-xs text-status-blocked">
              Unreachable — is `mimir serve` running?
            </p>
          )}
        </BrowserPage>
      </main>
    </>
  );
}
