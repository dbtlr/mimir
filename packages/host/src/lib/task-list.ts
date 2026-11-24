import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { EngineNode, Priority, Size, TaskStatusWord } from '@mimir/contract';

import { isFinishedSelection } from '../api/browse-queries';
import type { TaskFilters } from '../api/browse-queries';
import { lastSevenDays } from './home';
import { TASK_STATUS_ORDER } from './status';

/*
 * The Tasks list's presets and filters (ADR 0013, MMR-724 refinement): what a
 * `/p/KEY/tasks` URL asks for, the read each one sends, and the Filter
 * sheet's draft of them. Pure, so the page, the sheet, and Home's See all
 * links agree on one spelling.
 */

/** The presets, as the URL's `show` spells them. No preset is every live task. */
export const TASK_PRESETS = ['in-flight', 'ready', 'going-cold', 'shipped-week'] as const;
export type TaskPreset = (typeof TASK_PRESETS)[number];

/** The sorts the Filter sheet offers; `recent` is the default and leaves the URL. */
export const TASK_SORTS = ['recent', 'priority', 'oldest'] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

/** A preset's chip label, the Show option that picks it. */
export const PRESET_LABEL: Record<TaskPreset, string> = {
  'going-cold': 'Going cold',
  'in-flight': 'In flight',
  ready: 'Ready',
  'shipped-week': 'Shipped, last 7 days',
};

const isTerminal = (word: TaskStatusWord) => word === 'done' || word === 'abandoned';

/** Every live task status, in display order. */
export const LIVE_TASK_STATUSES: readonly TaskStatusWord[] = TASK_STATUS_ORDER.filter(
  (word) => !isTerminal(word),
);

/** The statuses each Show option's universe holds: the Filter sheet's Status options. */
export function presetStatuses(show: TaskPreset | undefined): readonly TaskStatusWord[] {
  switch (show) {
    case 'in-flight': {
      return ['in_progress', 'under_review', 'staged', 'queued'];
    }
    case 'ready': {
      return ['ready'];
    }
    case 'shipped-week': {
      return ['done'];
    }
    case 'going-cold':
    case undefined: {
      return LIVE_TASK_STATUSES;
    }
    default: {
      const _exhaustive: never = show;
      return _exhaustive;
    }
  }
}

/** What a Tasks URL carries, as the route validates it. */
export type TaskListSearch = {
  show?: TaskPreset;
  status?: string;
  q?: string;
  priority?: string;
  size?: string;
  tag?: string;
  sort?: TaskSort;
};

/** A link to `project`'s Tasks list with `show` set: Home's See all doors (MMR-724). */
export function presetLink(project: string, show: TaskPreset) {
  return { params: { key: project }, search: { show }, to: '/p/$key/tasks' as const };
}

export const isTaskPreset = (value: string | undefined): value is TaskPreset =>
  (TASK_PRESETS as readonly (string | undefined)[]).includes(value);

export const isTaskSort = (value: string | undefined): value is TaskSort =>
  (TASK_SORTS as readonly (string | undefined)[]).includes(value);

/** A comma list's distinct, non-empty values, in order. */
export function csv(value: string | undefined): string[] {
  const seen: string[] = [];
  for (const token of (value ?? '').split(',').map((t) => t.trim())) {
    if (token !== '' && !seen.includes(token)) {
      seen.push(token);
    }
  }
  return seen;
}

const pick = <T extends string>(values: readonly T[], from: string | undefined): T[] =>
  csv(from).filter((token): token is T => (values as readonly string[]).includes(token));

/** The URL's priorities, sizes, and tags, each an any-of filter. */
export function narrowing(search: TaskListSearch): {
  priorities: Priority[];
  sizes: Size[];
  tags: string[];
} {
  return {
    priorities: pick(PRIORITY_VALUES, search.priority),
    sizes: pick(SIZE_VALUES, search.size),
    tags: csv(search.tag),
  };
}

/**
 * The statuses a preset's URL narrows it to: the URL's status words inside the
 * preset's universe, in display order, or the whole universe when it names
 * none of them.
 */
export function presetSelection(show: TaskPreset | undefined, status: string | undefined) {
  const universe = presetStatuses(show);
  const asked = csv(status);
  const kept = universe.filter((word) => asked.includes(word));
  return kept.length > 0 ? kept : universe;
}

/**
 * The status selector a link carries that no Show option holds: with no
 * preset, a `status` that names anything beyond the live statuses
 * (`terminal`, `ready,done`, or a word no selector knows). It filters as its
 * own removable chip, and the Filter sheet keeps it. A status within the live
 * statuses narrows every live task instead, as the sheet writes it, and counts
 * under Filter.
 */
export function carriedSelector(search: TaskListSearch): string | undefined {
  if (search.show !== undefined || search.status === undefined) {
    return undefined;
  }
  const asked = csv(search.status);
  const live = asked.every(
    (word) => word === 'live' || (LIVE_TASK_STATUSES as readonly string[]).includes(word),
  );
  return live ? undefined : search.status;
}

/** The status selector a preset sends, before any narrowing. */
const PRESET_SELECTOR: Record<TaskPreset, string> = {
  'going-cold': 'live',
  'in-flight': 'in_progress,under_review,staged,queued',
  ready: 'ready',
  'shipped-week': 'done',
};

/**
 * The list read a Tasks URL sends (ADR 0013, MMR-724 refinement). A preset
 * picks its universe: in flight is in progress, under review, staged, and
 * queued, core's in-flight words (`isInFlightWord`), which Home's Now counts;
 * ready is ready; going cold is the live tasks the stale verdict holds;
 * shipped in the last 7 days is the done tasks whose `completed_at`
 * falls in the seven days ending today in `zone`, bare dates bounded at both
 * ends (ADR 0029), the window Home's Shipped counts. With no preset, `status` is any selector a link carries, and the
 * default is every live task. Priority, size, and tag narrow it as any-of
 * field filters.
 */
export function taskListFilters(
  search: TaskListSearch,
  { project, zone, now = Date.now() }: { project: string; zone: string; now?: number },
): TaskFilters {
  const filters: TaskFilters = { lede: true, project };
  const { show } = search;
  if (show === undefined) {
    filters.status = search.status ?? 'live';
  } else {
    const universe = presetStatuses(show);
    const selection = presetSelection(show, search.status);
    filters.status =
      selection.length === universe.length ? PRESET_SELECTOR[show] : selection.join(',');
  }
  if (search.q !== undefined) {
    filters.q = search.q;
  }
  const fieldFilters: NonNullable<TaskFilters['filters']> = [];
  if (show === 'shipped-week') {
    const { first, today } = lastSevenDays(zone, now);
    fieldFilters.push(
      { field: 'completed_at', op: 'at-or-after', value: first },
      { field: 'completed_at', op: 'at-or-before', value: today },
    );
    filters.timeZone = zone;
  }
  const { priorities, sizes, tags } = narrowing(search);
  for (const [field, values] of [
    ['priority', priorities],
    ['size', sizes],
    ['tag', tags],
  ] as const) {
    if (values.length > 0) {
      fieldFilters.push({ field, op: 'in', value: values.join(',') });
    }
  }
  if (fieldFilters.length > 0) {
    filters.filters = fieldFilters;
  }
  if (show === 'going-cold') {
    filters.verdicts = [{ negate: false, verdict: 'stale' }];
  }
  return filters;
}

/** "3 tasks in flight": the count line's words for a view, singular at one. */
export function countLine(
  view: { show: TaskPreset | undefined; status: string | undefined },
  shown: number,
  total: number,
): string {
  const of = shown < total ? `${shown.toLocaleString('en-US')} of ` : '';
  const n = `${of}${total.toLocaleString('en-US')}`;
  const tasks = total === 1 ? 'task' : 'tasks';
  switch (view.show) {
    case 'in-flight': {
      return `${n} ${tasks} in flight`;
    }
    case 'ready': {
      return `${n} ${tasks} ready`;
    }
    case 'going-cold': {
      return `${n} ${tasks} going cold`;
    }
    case 'shipped-week': {
      return `${n} shipped in the last 7 days`;
    }
    case undefined: {
      if (view.status === undefined || csv(view.status).includes('live')) {
        return `${n} live ${tasks}`;
      }
      return view.status === 'terminal' ? `${n} finished` : `${n} ${tasks}`;
    }
    default: {
      const _exhaustive: never = view.show;
      return _exhaustive;
    }
  }
}

const PRIORITY_RANK: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

/** Latest activity first. */
const recent = (a: EngineNode, b: EngineNode) => b.updatedAt.getTime() - a.updatedAt.getTime();

/** A priority's place in the Priority sort; a task with none sorts last. */
const priorityRank = (n: EngineNode) => (n.priority == null ? 4 : PRIORITY_RANK[n.priority]);

/** A live group's row order for a sort: latest activity first, priority first, or oldest first. */
export function bySort(sort: TaskSort): (a: EngineNode, b: EngineNode) => number {
  switch (sort) {
    case 'recent': {
      return recent;
    }
    case 'oldest': {
      return (a, b) => -recent(a, b);
    }
    case 'priority': {
      return (a, b) => priorityRank(a) - priorityRank(b) || recent(a, b);
    }
    default: {
      const _exhaustive: never = sort;
      return _exhaustive;
    }
  }
}

/** The Filter sheet's fields before they apply. `all` in Show is every live task. */
export type TaskFilterDraft = {
  show: TaskPreset | 'all';
  /**
   * A link's status selector no Show option holds (`carriedSelector`), kept
   * in place of Show and Status until Show changes or Clear.
   */
  carried?: string;
  /** The checked statuses, inside the Show option's universe. */
  statuses: TaskStatusWord[];
  priorities: Priority[];
  sizes: Size[];
  tags: string[];
  sort: TaskSort;
};

/**
 * The draft an applied URL opens the sheet with, keeping a status no Show
 * option holds. With no preset, a union with `live` in it (`live,ready`) is
 * every live task, with no status narrowed.
 */
export function draftOf(search: TaskListSearch): TaskFilterDraft {
  const show = search.show ?? 'all';
  const preset = show === 'all' ? undefined : show;
  const carried = carriedSelector(search);
  const everyLive = preset === undefined && csv(search.status).includes('live');
  const narrowedBy = carried === undefined && !everyLive ? search.status : undefined;
  return {
    ...narrowing(search),
    ...(carried === undefined ? {} : { carried }),
    show,
    sort: search.sort ?? 'recent',
    statuses: [...presetSelection(preset, narrowedBy)],
  };
}

/** The status selector a draft reads before its statuses narrow it: its Show option's universe. */
export const draftSelector = (draft: TaskFilterDraft) =>
  draft.carried ?? (draft.show === 'all' ? 'live' : PRESET_SELECTOR[draft.show]);

/** Whether a draft selects finished work only, which folds by day and takes no sort. */
export const draftIsFinished = (draft: TaskFilterDraft): boolean =>
  isFinishedSelection(draftSelector(draft));

/** The draft Clear leaves: every live task, nothing narrowed, the default sort. */
export const CLEARED_DRAFT: TaskFilterDraft = {
  priorities: [],
  show: 'all',
  sizes: [],
  sort: 'recent',
  statuses: [...LIVE_TASK_STATUSES],
  tags: [],
};

/**
 * A draft with another Show option: its statuses start over at that option's
 * whole universe, in place of any selector a link carried.
 */
export function withShow(
  { carried: _replaced, ...draft }: TaskFilterDraft,
  show: TaskFilterDraft['show'],
): TaskFilterDraft {
  return { ...draft, show, statuses: [...presetStatuses(show === 'all' ? undefined : show)] };
}

/** A comma list of values, or nothing for none. */
const listOf = (values: readonly string[]) => (values.length > 0 ? values.join(',') : undefined);

/**
 * The URL a draft applies as, keeping the search text. Defaults leave the URL,
 * and so does a sort for finished work, which takes none.
 */
export function searchOf(draft: TaskFilterDraft, q: string | undefined): TaskListSearch {
  const preset = draft.show === 'all' ? undefined : draft.show;
  const universe = presetStatuses(preset);
  const narrowed = draft.statuses.length > 0 && draft.statuses.length < universe.length;
  const status =
    draft.carried ??
    (narrowed ? universe.filter((w) => draft.statuses.includes(w)).join(',') : undefined);
  const priority = listOf(draft.priorities);
  const size = listOf(draft.sizes);
  const tag = listOf(draft.tags);
  return {
    ...(preset === undefined ? {} : { show: preset }),
    ...(status === undefined ? {} : { status }),
    ...(q === undefined ? {} : { q }),
    ...(priority === undefined ? {} : { priority }),
    ...(size === undefined ? {} : { size }),
    ...(tag === undefined ? {} : { tag }),
    ...(draft.sort === 'recent' || draftIsFinished(draft) ? {} : { sort: draft.sort }),
  };
}

/**
 * How many filters a URL applies beyond its chip: narrowed statuses, priority,
 * size, tag, and sort. A selector a link carries is the chip's, not Filter's,
 * and a sort for finished work, which takes none, counts for nothing.
 */
export function extraFilterCount(search: TaskListSearch): number {
  const draft = draftOf(search);
  const universe = presetStatuses(search.show);
  return [
    draft.carried === undefined && draft.statuses.length < universe.length,
    draft.priorities.length > 0,
    draft.sizes.length > 0,
    draft.tags.length > 0,
    draft.sort !== 'recent' && !draftIsFinished(draft),
  ].filter(Boolean).length;
}
