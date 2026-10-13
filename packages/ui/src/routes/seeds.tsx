import { SEED_KIND_VALUES } from '@mimir/contract';
import type { SeedKind } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useEffectEvent, useId, useMemo, useState } from 'react';

import { projectsQuery, seedsQuery } from '../api/queries';
import type { SeedFilters } from '../api/queries';
import type { WireSeed } from '../api/types';
import {
  BrowserEmpty,
  BrowserGroup,
  BrowserPage,
  BrowserRow,
  BrowserSearch,
  FilterRow,
  MenuChip,
} from '../components/browser-list';
import { OfflineBanner } from '../components/offline-banner';
import { useSeedCapture } from '../components/seed-capture';
import { SeedKindChip } from '../components/seed-kind-chip';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { seedLink } from '../lib/record-url';
import {
  SEED_LANE_INK,
  SEED_LANE_LABEL,
  groupSeedsByLane,
  isSeedKind,
  seedMatchesQuery,
  seedSummary,
} from '../lib/seed-lanes';
import { relativeTime } from '../lib/time';
import { seedsRoute } from '../router';

const SEARCH_DEBOUNCE_MS = 250;

const ALL = '';

/** The header's faint count: untriaged and ready-to-resolve seeds, a zero half omitted. */
function summaryText(toTriage: number, toResolve: number): string | undefined {
  const parts = [
    toTriage > 0 ? `${String(toTriage)} to triage` : undefined,
    toResolve > 0 ? `${String(toResolve)} to resolve` : undefined,
  ].filter((p) => p !== undefined);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** `from {requester} · {age}` when filed from another project, else just the age. */
function seedMeta(seed: WireSeed): string {
  const age = relativeTime(seed.created_at);
  return seed.requester !== null && seed.requester !== seed.project
    ? `from ${seed.requester} · ${age}`
    : age;
}

function SeedBrowserRow({ seed, demoted = false }: { seed: WireSeed; demoted?: boolean }) {
  return (
    <BrowserRow
      to={seedLink(seed.id)}
      id={seed.id}
      title={seed.title}
      beforeTitle={<SeedKindChip kind={seed.kind} />}
      lede={seed.lede}
      meta={seedMeta(seed)}
      demoted={demoted}
    />
  );
}

/** A folded lane (PARKED or SETTLED): its count shows, its rows stay hidden until
 * the reader asks. Settled rows read demoted; parked rows are still live. */
function FoldedGroup({ lane, seeds }: { lane: 'parked' | 'settled'; seeds: readonly WireSeed[] }) {
  const [shown, setShown] = useState(false);
  const rowsId = useId();
  return (
    <BrowserGroup
      label={SEED_LANE_LABEL[lane]}
      count={seeds.length}
      labelClassName={SEED_LANE_INK[lane]}
    >
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={rowsId}
        onClick={() => {
          setShown((s) => !s);
        }}
        className="mb-1 rounded-sm px-1 text-[0.78125rem] text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {shown ? `Hide ${lane} seeds` : `Show ${lane} seeds`}
      </button>
      {shown && (
        <div id={rowsId}>
          {seeds.map((seed) => (
            <SeedBrowserRow key={seed.id} seed={seed} demoted={lane === 'settled'} />
          ))}
        </div>
      )}
    </BrowserGroup>
  );
}

/**
 * `/seeds` — the grooming queue as a grouped reading list (MMR-454): a centred
 * column, search and project/kind chips, and rows grouped by the server's
 * `lane` in fixed order. Every row links to the seed's page; PARKED and SETTLED
 * fold behind a "Show … seeds" control. Search and kind filter client-side;
 * the project filter is the server's.
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
  const projects = useQuery(projectsQuery);
  const conn = connectivity([seeds]);

  const setFilter = (partial: { project?: string; q?: string; kind?: SeedKind }) =>
    void navigate({
      replace: true,
      search: (prev) => {
        const next: Record<string, unknown> = { ...prev, ...partial };
        for (const [k, v] of Object.entries(partial)) {
          if (v === '' || v === undefined) {
            delete next[k];
          }
        }
        return next;
      },
      to: '/seeds',
    });

  // Controlled + debounced search (the /tasks pattern): the box and the list
  // filter now, the URL trails by the debounce; an external `q` change
  // (Back/clear) re-syncs during render.
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

  const all = seeds.data?.items;
  const shown = useMemo(
    () =>
      (all ?? []).filter(
        (s) => (search.kind === undefined || s.kind === search.kind) && seedMatchesQuery(s, q),
      ),
    [all, search.kind, q],
  );
  const groups = groupSeedsByLane(shown);
  const { toTriage, toResolve } = seedSummary(all ?? []);
  const loaded = seeds.data !== undefined;

  const projectOptions = [
    { label: 'All projects', value: ALL },
    ...(projects.data?.items ?? []).map((p) => ({ label: p.id, value: p.id })),
  ];
  const kindOptions = [
    { label: 'Any kind', value: ALL },
    ...SEED_KIND_VALUES.map((k) => ({ label: k, value: k })),
  ];

  return (
    <>
      <OfflineBanner {...conn} />
      <main
        className={cn(
          'flex min-h-0 w-full flex-1 flex-col overflow-y-auto',
          conn.offline && 'offline-demoted',
        )}
      >
        <BrowserPage
          title="Seeds"
          count={summaryText(toTriage, toResolve)}
          action={
            <button
              type="button"
              onClick={openCapture}
              className="inline-flex items-center rounded-lg bg-action px-[13px] py-1.5 text-tag font-bold whitespace-nowrap text-action-foreground transition-colors hover:bg-action/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              + File a seed
            </button>
          }
        >
          <FilterRow>
            <BrowserSearch
              value={q}
              onChange={setQ}
              label="Search seeds"
              placeholder="Search seeds…"
            />
            <MenuChip
              label={search.project ?? 'All projects'}
              on={search.project !== undefined}
              options={projectOptions}
              onSelect={(value) => {
                setFilter({ project: value });
              }}
            />
            <MenuChip
              label={search.kind ?? 'Any kind'}
              on={search.kind !== undefined}
              options={kindOptions}
              onSelect={(value) => {
                setFilter({ kind: isSeedKind(value) ? value : undefined });
              }}
            />
          </FilterRow>

          {seeds.isPending && <Skeleton className="h-24" />}
          {groups.map(({ lane, seeds: laneSeeds }) =>
            lane === 'parked' || lane === 'settled' ? (
              <FoldedGroup key={lane} lane={lane} seeds={laneSeeds} />
            ) : (
              <BrowserGroup
                key={lane}
                label={SEED_LANE_LABEL[lane]}
                count={laneSeeds.length}
                labelClassName={SEED_LANE_INK[lane]}
              >
                {laneSeeds.map((seed) => (
                  <SeedBrowserRow key={seed.id} seed={seed} />
                ))}
              </BrowserGroup>
            ),
          )}
          {loaded && all?.length === 0 && (
            <BrowserEmpty>
              No seeds yet — press <span className="font-mono text-ink-dim">s</span> to file one.
            </BrowserEmpty>
          )}
          {loaded && all !== undefined && all.length > 0 && shown.length === 0 && (
            <BrowserEmpty>No seeds match.</BrowserEmpty>
          )}
          {seeds.isError && !loaded && (
            <p className="p-4 text-xs text-status-blocked">
              Unreachable — is `mimir serve` running?
            </p>
          )}
        </BrowserPage>
      </main>
    </>
  );
}
