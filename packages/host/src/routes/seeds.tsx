import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { seedsQuery } from '../api/browse-queries';
import type { EngineSeed } from '../api/browse-queries';
import { BrowserSearch } from '../components/browser-list';
import { FeedCard } from '../components/patterns/feed/card';
import { CardGrid } from '../components/patterns/feed/card-grid';
import { Fold } from '../components/patterns/feed/day-fold';
import { FeedPreview } from '../components/patterns/feed/feed-preview';
import { PreviewRelation } from '../components/patterns/feed/preview-panel';
import type { Preview } from '../components/patterns/feed/preview-panel';
import { Quiet } from '../components/patterns/feed/quiet';
import {
  CountLineAction,
  FilterChip,
  ListGroup,
  ListPage,
  PresetChip,
} from '../components/patterns/list-page';
import { ProjectFrame } from '../components/project-frame';
import { useSeedCapture } from '../components/seed-capture';
import { SeedFilterSheet } from '../components/seed-filter-sheet';
import { SeedKindChip } from '../components/seed-kind-chip';
import { PlusIcon } from '../components/ui/icons';
import { Skeleton } from '../components/ui/skeleton';
import { seedLink } from '../lib/record-url';
import { SEED_LANE_LABEL, groupSeedsByLane, laneOf } from '../lib/seed-lanes';
import {
  SEED_SHOW_LABEL,
  seedCountLine,
  seedKinds,
  seedsInView,
  seedsMatching,
} from '../lib/seed-list';
import type { SeedListSearch, SeedShow } from '../lib/seed-list';
import { ago, relativeTime } from '../lib/time';
import { useSearchText } from '../lib/use-search-text';
import { seedsRoute } from '../router';

/** What a view says when its lane is empty and nothing else narrows it. */
const EMPTY_VIEW: Record<SeedShow, string> = {
  parked: 'Nothing is parked.',
  'ready-to-resolve': 'Nothing is ready to resolve.',
  settled: 'Nothing has settled yet.',
  'to-triage': 'Nothing to triage. Every seed has a lane.',
};

/** "from FLT": where a seed was filed, when that is another project. */
function origin(seed: EngineSeed): ReactNode {
  return seed.requester !== null && seed.requester !== seed.project ? (
    <span>
      from <span className="font-mono">{seed.requester}</span>
    </span>
  ) : undefined;
}

/** The IDs a seed spawned, in mono, comma separated. */
function spawnedIds(seed: EngineSeed): ReactNode {
  return seed.spawned.map((id, i) => (
    <span key={id}>
      {i > 0 && ', '}
      <span className="font-mono">{id}</span>
    </span>
  ));
}

/**
 * Where a seed's spawned work stands, the card's detail line: "MMR-699 is
 * done" for a seed ready to resolve, "Became MMR-456" for a promoted one,
 * and the outcome of a settled one.
 */
function seedDetail(seed: EngineSeed): ReactNode {
  switch (laneOf(seed)) {
    case 'ready': {
      return (
        <>
          {spawnedIds(seed)} {seed.spawned.length === 1 ? 'is' : 'are'} done
        </>
      );
    }
    case 'promoted': {
      return seed.spawned.length === 0 ? undefined : <>Became {spawnedIds(seed)}</>;
    }
    case 'settled': {
      return seed.lifecycle === 'rejected' ? 'Rejected' : 'Resolved';
    }
    case 'untriaged':
    case 'parked': {
      return undefined;
    }
    default: {
      return undefined;
    }
  }
}

/** A seed's preview: its lane and when it was filed, its lede, and the work it became. */
function seedPreview(seed: EngineSeed): Preview {
  const lane = laneOf(seed);
  const standing = lane === 'settled' ? seedDetail(seed) : SEED_LANE_LABEL[lane];
  const facts =
    seed.spawned.length === 0
      ? []
      : [
          {
            label: 'Became',
            value: seed.spawned.map((id) => <PreviewRelation key={id} id={id} />),
          },
        ];
  return {
    age: relativeTime(seed.createdAt),
    facts,
    id: seed.id,
    lead: <SeedKindChip kind={seed.kind} />,
    open: seedLink(seed.id),
    project: origin(seed),
    reason: (
      <>
        <b>{standing}.</b> Filed {ago(seed.createdAt)}.
      </>
    ),
    text: seed.lede === null || seed.lede === undefined || seed.lede === '' ? undefined : seed.lede,
    title: seed.title,
  };
}

/** A seed as a feed card: its kind, ID, origin, and age, the title, and where its work stands. */
function SeedCard({ seed }: { seed: EngineSeed }) {
  return (
    <FeedCard
      previewKey={seed.id}
      lead={<SeedKindChip kind={seed.kind} />}
      id={seed.id}
      project={origin(seed)}
      age={relativeTime(seed.createdAt)}
      title={seed.title}
      detail={seedDetail(seed)}
      cold={laneOf(seed) === 'settled'}
    />
  );
}

function SeedCards({ seeds }: { seeds: readonly EngineSeed[] }) {
  return (
    <CardGrid>
      {seeds.map((seed) => (
        <SeedCard key={seed.id} seed={seed} />
      ))}
    </CardGrid>
  );
}

/** A lane set aside (Parked, Settled) as a fold row, closed until opened, its cards inside. */
function LaneFold({ label, seeds }: { label: string; seeds: readonly EngineSeed[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Fold label={label} count={seeds.length} open={open} onOpenChange={setOpen}>
      <div className="pt-1 pb-4">
        <SeedCards seeds={seeds} />
      </div>
    </Fold>
  );
}

/**
 * `/p/KEY/seeds`: the Seeds list (ADR 0013, MMR-725 refinement; ADR 0019's
 * list page). The count line with File a seed at its right, the search, the
 * view as a removable chip and Filter, then the seeds as cards that open their
 * preview. With no view the live lanes (To triage, Ready to resolve, Promoted)
 * head groups that pin while they scroll, and Parked and Settled fold after
 * them; a view lists its lane alone. The list reads the project's every seed
 * once and filters here; every filter is in the URL (`show`, `kind`, `q`).
 */
export function SeedsPage() {
  const navigate = useNavigate();
  const { key: project } = seedsRoute.useParams();
  const search = seedsRoute.useSearch();
  const openCapture = useSeedCapture();
  const seeds = useQuery(seedsQuery({ project }));
  const searchRef = useRef<HTMLDivElement>(null);
  const filterChip = useRef<HTMLButtonElement>(null);
  const cards = useRef<HTMLDivElement>(null);
  const [filtering, setFiltering] = useState(false);

  const apply = (next: SeedListSearch) =>
    void navigate({ params: { key: project }, replace: true, search: next, to: '/p/$key/seeds' });

  const [q, setQ] = useSearchText(search.q, (value) => {
    const { q: _q, ...rest } = search;
    apply(value === '' ? rest : { ...rest, q: value });
  });

  const all = seeds.data;
  const matching = useMemo(
    () => seedsMatching(all ?? [], { kind: search.kind, q }),
    [all, search.kind, q],
  );
  const byId = useMemo(() => new Map(matching.map((seed) => [seed.id, seed])), [matching]);
  const { show } = search;
  const groups = show === undefined ? groupSeedsByLane(matching) : [];
  const live = groups.filter(({ lane }) => lane !== 'parked' && lane !== 'settled');
  const setAside = groups.filter(({ lane }) => lane === 'parked' || lane === 'settled');
  const inView = show === undefined ? [] : seedsInView(matching, show);
  const narrowed = q !== '' || seedKinds(search.kind).length > 0;

  let empty: string | undefined;
  if (all !== undefined) {
    if (all.length === 0) {
      empty = 'No seeds yet.';
    } else if (matching.length === 0 || (show !== undefined && inView.length === 0 && narrowed)) {
      empty = 'No seeds match.';
    } else if (show !== undefined && inView.length === 0) {
      empty = EMPTY_VIEW[show];
    }
  }

  return (
    <ProjectFrame projectKey={project} tab="seeds" reads={[seeds]}>
      <ListPage
        label="Seeds"
        count={all !== undefined && seedCountLine(matching, show)}
        countAction={
          <CountLineAction icon={<PlusIcon className="size-4 md:size-4" />} onClick={openCapture}>
            File a seed
          </CountLineAction>
        }
        search={
          <div ref={searchRef}>
            <BrowserSearch
              value={q}
              onChange={setQ}
              label="Search seeds"
              placeholder="Search titles and IDs"
            />
          </div>
        }
        chips={
          <>
            {show !== undefined && (
              <PresetChip
                label={SEED_SHOW_LABEL[show]}
                onRemove={() => {
                  searchRef.current?.querySelector('input')?.focus();
                  const { show: _show, ...rest } = search;
                  apply(rest);
                }}
              />
            )}
            <FilterChip
              ref={filterChip}
              open={filtering}
              applied={seedKinds(search.kind).length > 0 ? 1 : 0}
              onClick={() => {
                setFiltering(true);
              }}
            />
          </>
        }
      >
        {seeds.isPending && <Skeleton className="h-40" />}
        {seeds.isError && all === undefined && (
          <p className="text-meta text-status-blocked-foreground">
            Unreachable — is the Mimir host running?
          </p>
        )}
        {empty !== undefined && <Quiet>{empty}</Quiet>}
        {matching.length > 0 && (
          <FeedPreview
            // When a refetch drops the card that opened the preview, focus a shown card.
            fallbackFocus={() =>
              cards.current?.querySelector<HTMLElement>('[data-slot="feed-card-target"]') ?? null
            }
            preview={(key) => {
              const seed = byId.get(key);
              return seed === undefined ? undefined : seedPreview(seed);
            }}
          >
            <div ref={cards}>
              {inView.length > 0 && <SeedCards seeds={inView} />}
              {live.map(({ lane, seeds: laneSeeds }) => (
                <ListGroup key={lane} title={SEED_LANE_LABEL[lane]} count={laneSeeds.length}>
                  <SeedCards seeds={laneSeeds} />
                </ListGroup>
              ))}
              {setAside.length > 0 && (
                <div className="mt-8 flex flex-col first:mt-0">
                  {setAside.map(({ lane, seeds: laneSeeds }) => (
                    <LaneFold key={lane} label={SEED_LANE_LABEL[lane]} seeds={laneSeeds} />
                  ))}
                </div>
              )}
            </div>
          </FeedPreview>
        )}
      </ListPage>
      <SeedFilterSheet
        open={filtering}
        onClose={() => {
          setFiltering(false);
        }}
        seeds={all ?? []}
        search={search}
        finalFocus={() => filterChip.current}
        onApply={apply}
      />
    </ProjectFrame>
  );
}
