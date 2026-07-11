import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { seedsQuery } from '../api/queries';
import type { SeedFilters } from '../api/queries';
import { OfflineBanner } from '../components/offline-banner';
import { useSeedCapture } from '../components/seed-capture';
import { SeedDetail } from '../components/seed-detail';
import { SeedRow } from '../components/seed-row';
import { SeedSettledStrip } from '../components/seed-settled-strip';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { SEED_LANE_INK, SEED_LANE_LABEL, groupSeedsByLane, seedSummary } from '../lib/seed-lanes';
import { seedsRoute } from '../router';

/**
 * `/seeds` — the grooming queue (Meridian 13a/14a, MMR-247). A full-width
 * stacked expand-in-place list below the master-detail breakpoint; a fixed
 * master list beside a reading pane at and above it (the artifacts-browser
 * grammar). Lanes are the server's `lane` grouping in fixed order; SETTLED
 * folds to a bottom strip.
 */
export function SeedsPage() {
  const navigate = useNavigate();
  const search = seedsRoute.useSearch();
  const openCapture = useSeedCapture();

  const filters: SeedFilters = {};
  if (search.project !== undefined) {
    filters.project = search.project;
  }
  const seeds = useQuery(seedsQuery(filters));
  const conn = connectivity([seeds]);

  const items = seeds.data?.items ?? [];
  const groups = groupSeedsByLane(items);
  const { toTriage, toResolve } = seedSummary(items);
  const selected = search.seed;

  const select = (id: string | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, seed: id }), to: '/seeds' });

  return (
    <>
      <OfflineBanner {...conn} />
      <main className={cn('flex min-h-0 flex-1', conn.offline && 'offline-demoted')}>
        <div className="flex min-h-0 w-full flex-col border-line bg-well-950 md:w-96 md:shrink-0 md:border-r">
          <header className="flex flex-wrap items-center gap-2.5 px-4 pt-4 pb-2.5">
            <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">Seeds</h1>
            <span className="text-tag text-ink-faint">
              {toTriage} to triage · {toResolve} to resolve
            </span>
            <button
              type="button"
              onClick={openCapture}
              className="ml-auto rounded-lg bg-action px-3 py-1.5 text-tag font-bold whitespace-nowrap text-action-foreground transition-colors hover:bg-action/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              + File a seed
            </button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-3 py-3">
            {seeds.isPending && <Skeleton className="h-24" />}
            {groups.map(({ lane, seeds: laneSeeds }) =>
              lane === 'settled' ? (
                <SeedSettledStrip
                  key={lane}
                  seeds={laneSeeds}
                  activeId={selected}
                  onSelect={select}
                />
              ) : (
                <section
                  key={lane}
                  aria-label={SEED_LANE_LABEL[lane]}
                  className="flex flex-col gap-2"
                >
                  <div className="flex items-center gap-2">
                    <span className={cn('microlabel shrink-0 font-mono', SEED_LANE_INK[lane])}>
                      {SEED_LANE_LABEL[lane]} · {laneSeeds.length}
                    </span>
                    <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
                  </div>
                  {laneSeeds.map((seed) => (
                    <SeedRow
                      key={seed.id}
                      seed={seed}
                      active={seed.id === selected}
                      onSelect={select}
                      offline={conn.offline}
                    />
                  ))}
                </section>
              ),
            )}
            {!seeds.isPending && items.length === 0 && seeds.data !== undefined && (
              <p className="px-1 py-8 text-center text-xs text-ink-faint">
                No seeds yet — press <span className="font-mono text-ink-dim">s</span> to file one.
              </p>
            )}
            {seeds.isError && seeds.data === undefined && (
              <p className="p-4 text-xs text-status-blocked">
                Unreachable — is `mimir serve` running?
              </p>
            )}
          </div>
        </div>

        <div className="hidden min-h-0 flex-1 flex-col bg-well-900 md:flex">
          {selected !== undefined ? (
            <SeedDetail
              key={selected}
              id={selected}
              onLater={() => select(undefined)}
              offline={conn.offline}
            />
          ) : (
            <p className="flex w-full items-center justify-center p-8 text-xs text-ink-faint">
              Select a seed to read.
            </p>
          )}
        </div>
      </main>
    </>
  );
}
