import type { ArtifactFilters } from '../api/browse-queries';
import { kindTagLabel } from './artifacts';
import { dayOf } from './work-page';

/*
 * The Artifacts list's filters (ADR 0013, MMR-725 refinement): what an
 * `/p/KEY/artifacts` URL asks for, the read it sends, and the chips it shows.
 * The Filter sheet holds the kind, which is a tag; a plain tag and the date
 * bounds a link carries each keep a removable chip of their own.
 */

/** What an Artifacts URL carries, as the route validates it. */
export type ArtifactListSearch = {
  tag?: string;
  q?: string;
  atOrAfter?: string;
  atOrBefore?: string;
};

/** The read an Artifacts URL sends, scoped to the path's project. */
export function artifactListFilters(search: ArtifactListSearch, project: string): ArtifactFilters {
  const filters: ArtifactFilters = { project };
  for (const key of ['tag', 'q', 'atOrAfter', 'atOrBefore'] as const) {
    const value = search[key];
    if (value !== undefined) {
      filters[key] = value;
    }
  }
  return filters;
}

/** The kind tag the URL picks, when its tag names a kind. */
export function chosenKind(search: ArtifactListSearch): string | undefined {
  return search.tag !== undefined && kindTagLabel(search.tag) !== undefined
    ? search.tag
    : undefined;
}

/** "20 November", or "20 November 2025" outside `year`: a bare date named in UTC, so no zone moves it. */
function dateLabel(day: string, year: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) {
    return day;
  }
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    ...(day.startsWith(year) ? {} : { year: 'numeric' }),
  }).format(Date.parse(`${day}T00:00:00.000Z`));
}

/** A filter a link carries that the Filter sheet does not hold, as its chip. */
export type CarriedChip = {
  key: 'tag' | 'atOrAfter' | 'atOrBefore';
  /** The chip's words before the value ("Tagged", "Since"). */
  lead: string;
  value: string;
  /** Whether the value is machine vocabulary, set in mono (a tag). */
  mono: boolean;
};

/**
 * The chips a URL's plain tag and date bounds show, in that order: "Tagged
 * `workspace_unconsolidated`", "Since 20 November", "Until 24 November".
 * A tag that names a kind is the Filter sheet's instead. A date outside this
 * year in `zone` names its year.
 */
export function carriedChips(
  search: ArtifactListSearch,
  { zone, now = Date.now() }: { zone: string; now?: number },
): CarriedChip[] {
  const thisYear = dayOf(now, zone).slice(0, 4);
  const chips: CarriedChip[] = [];
  if (search.tag !== undefined && chosenKind(search) === undefined) {
    chips.push({ key: 'tag', lead: 'Tagged', mono: true, value: search.tag });
  }
  if (search.atOrAfter !== undefined) {
    const value = dateLabel(search.atOrAfter, thisYear);
    chips.push({ key: 'atOrAfter', lead: 'Since', mono: false, value });
  }
  if (search.atOrBefore !== undefined) {
    const value = dateLabel(search.atOrBefore, thisYear);
    chips.push({ key: 'atOrBefore', lead: 'Until', mono: false, value });
  }
  return chips;
}

/** "40 of 449 artifacts": the count line's words, singular at one, "No artifacts" at none. */
export function artifactCountLine(shown: number, total: number): string {
  if (total === 0) {
    return 'No artifacts';
  }
  const of = shown < total ? `${shown.toLocaleString('en-US')} of ` : '';
  return `${of}${total.toLocaleString('en-US')} ${total === 1 ? 'artifact' : 'artifacts'}`;
}
