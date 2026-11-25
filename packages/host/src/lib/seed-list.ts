import { SEED_KIND_VALUES } from '@mimir/contract';
import type { SeedKind, SeedLane } from '@mimir/contract';

import type { EngineSeed } from '../api/browse-queries';
import { csv } from './comma-list';
import { laneOf, seedMatchesQuery } from './seed-lanes';

/*
 * The Seeds list's views and filters (ADR 0013, MMR-725 refinement): what a
 * `/p/KEY/seeds` URL asks for, the seeds it shows, and its count line. The
 * list reads a project's every seed once and filters here, so the page, the
 * Filter sheet's count, and Home's door agree on one spelling.
 */

/**
 * The views, as the URL's `show` spells them: the two presets, then the two
 * lanes the Filter sheet's Show also offers. No `show` is every lane; only it
 * lists Promoted.
 */
export const SEED_SHOWS = ['to-triage', 'ready-to-resolve', 'parked', 'settled'] as const;
export type SeedShow = (typeof SEED_SHOWS)[number];

/** The lane each view lists. */
export const SEED_SHOW_LANE: Record<SeedShow, SeedLane> = {
  parked: 'parked',
  'ready-to-resolve': 'ready',
  settled: 'settled',
  'to-triage': 'untriaged',
};

/** A view's chip label. */
export const SEED_SHOW_LABEL: Record<SeedShow, string> = {
  parked: 'Parked',
  'ready-to-resolve': 'Ready to resolve',
  settled: 'Settled',
  'to-triage': 'To triage',
};

export const isSeedShow = (value: string | undefined): value is SeedShow =>
  (SEED_SHOWS as readonly (string | undefined)[]).includes(value);

/** What a Seeds URL carries, as the route validates it. */
export type SeedListSearch = {
  show?: SeedShow;
  /** The kinds, a comma list (`bug,feature`); any kind when absent. */
  kind?: string;
  q?: string;
};

/** A link to `project`'s Seeds list on a view: Home's Seeds to triage door (MMR-725). */
export function seedShowLink(project: string, show: SeedShow) {
  return { params: { key: project }, search: { show }, to: '/p/$key/seeds' as const };
}

/** The kinds a URL's comma list names, in order, each once; words that name no kind drop out. */
export function seedKinds(kind: string | undefined): SeedKind[] {
  return csv(kind).filter((word): word is SeedKind =>
    (SEED_KIND_VALUES as readonly string[]).includes(word),
  );
}

/** The seeds a URL's kinds and search keep, before its view picks a lane. */
export function seedsMatching(
  seeds: readonly EngineSeed[],
  { kind, q }: { kind: string | undefined; q: string },
): EngineSeed[] {
  const kinds = seedKinds(kind);
  return seeds.filter(
    (seed) => (kinds.length === 0 || kinds.includes(seed.kind)) && seedMatchesQuery(seed, q),
  );
}

/** Whether a seed is open: every lifecycle but resolved and rejected, the tally the Seeds tab counts. */
export const isOpenSeed = (seed: EngineSeed) => laneOf(seed) !== 'settled';

/** The seeds a view lists: its lane, or every open seed with no view. */
export function seedsInView(seeds: readonly EngineSeed[], show: SeedShow | undefined) {
  return show === undefined
    ? seeds.filter(isOpenSeed)
    : seeds.filter((seed) => laneOf(seed) === SEED_SHOW_LANE[show]);
}

/** The open lanes the count line breaks down, in the list's order, with their words. */
const OPEN_LANE_WORDS: readonly (readonly [SeedLane, string])[] = [
  ['untriaged', 'to triage'],
  ['ready', 'ready to resolve'],
  ['promoted', 'promoted'],
  ['parked', 'parked'],
];

const seedsWord = (n: number) => (n === 1 ? 'seed' : 'seeds');

/**
 * The count line (DESIGN.md, List page). With no view it leads with the open
 * seeds, the Seeds tab's number, and breaks down every open lane that holds
 * any, so the parts sum: "43 open seeds: 11 to triage, 2 ready to resolve, 15
 * promoted, 15 parked". A view counts its lane: "11 seeds to triage".
 */
export function seedCountLine(seeds: readonly EngineSeed[], show: SeedShow | undefined): string {
  const n = seedsInView(seeds, show).length;
  const number = n.toLocaleString('en-US');
  switch (show) {
    case 'to-triage': {
      return n === 0 ? 'No seeds to triage' : `${number} ${seedsWord(n)} to triage`;
    }
    case 'ready-to-resolve': {
      return n === 0 ? 'No seeds ready to resolve' : `${number} ${seedsWord(n)} ready to resolve`;
    }
    case 'parked':
    case 'settled': {
      return n === 0 ? `No ${show} seeds` : `${number} ${show} ${seedsWord(n)}`;
    }
    case undefined: {
      if (n === 0) {
        return seeds.length === 0 ? 'No seeds' : 'No open seeds';
      }
      const parts = OPEN_LANE_WORDS.flatMap(([lane, words]) => {
        const inLane = seeds.filter((seed) => laneOf(seed) === lane).length;
        // No-break spaces hold each part together, so a phone wraps the line only after a comma.
        const part = `${inLane.toLocaleString('en-US')} ${words}`.replaceAll(' ', '\u00a0');
        return inLane === 0 ? [] : [part];
      });
      return `${number} open ${seedsWord(n)}: ${parts.join(', ')}`;
    }
    default: {
      const _exhaustive: never = show;
      return _exhaustive;
    }
  }
}

/** The Filter sheet's fields before they apply. `all` in Show is every lane. */
export type SeedFilterDraft = { show: SeedShow | 'all'; kinds: SeedKind[] };

/** The draft an applied URL opens the sheet with. */
export const seedDraftOf = (search: SeedListSearch): SeedFilterDraft => ({
  kinds: seedKinds(search.kind),
  show: search.show ?? 'all',
});

/** The draft Clear leaves: every lane, any kind. */
export const CLEARED_SEED_DRAFT: SeedFilterDraft = { kinds: [], show: 'all' };

/** The URL a draft applies as, keeping the search text. */
export function seedSearchOf(draft: SeedFilterDraft, q: string | undefined): SeedListSearch {
  return {
    ...(draft.show === 'all' ? {} : { show: draft.show }),
    ...(draft.kinds.length === 0 ? {} : { kind: draft.kinds.join(',') }),
    ...(q === undefined ? {} : { q }),
  };
}
