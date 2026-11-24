import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { Priority, Size, TaskStatusWord } from '@mimir/contract';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { taskTagsQuery, tasksCountQuery } from '../api/browse-queries';
import { browserTimeZone } from '../api/queries';
import { STATUS_META } from '../lib/status';
import {
  CLEARED_DRAFT,
  PRESET_LABEL,
  TASK_PRESETS,
  draftIsFinished,
  draftOf,
  presetStatuses,
  searchOf,
  taskListFilters,
  withShow,
} from '../lib/task-list';
import type { TaskFilterDraft, TaskListSearch, TaskSort } from '../lib/task-list';
import { FilterPills, FilterSegments, FilterSheet } from './patterns/filter-sheet';
import type { FilterOption } from './patterns/filter-sheet';
import type { FinalFocus } from './patterns/opener';
import { SIZE_GLYPH } from './signal-badges';
import { StatusDot } from './status-dot';

/** The Show options: the four presets, then every live task. */
const SHOW_OPTIONS: FilterOption<TaskFilterDraft['show']>[] = [
  ...TASK_PRESETS.map((preset) => ({ label: PRESET_LABEL[preset], value: preset })),
  { label: 'Every live task', value: 'all' },
];

const PRIORITY_OPTIONS: FilterOption<Priority>[] = PRIORITY_VALUES.map((p) => ({
  label: p,
  value: p,
}));

const SIZE_NAME: Record<Size, string> = { large: 'Large', medium: 'Medium', small: 'Small' };
const SIZE_OPTIONS: FilterOption<Size>[] = SIZE_VALUES.map((size) => ({
  label: SIZE_GLYPH[size],
  name: SIZE_NAME[size],
  value: size,
}));

const SORT_OPTIONS: { value: TaskSort; label: string }[] = [
  { label: 'Recent', value: 'recent' },
  { label: 'Priority', value: 'priority' },
  { label: 'Oldest', value: 'oldest' },
];

/** The Tag field shows this many pills before "N more". */
const TAG_LIMIT = 5;

const statusOptions = (statuses: readonly TaskStatusWord[]): FilterOption<TaskStatusWord>[] =>
  statuses.map((status) => ({
    label: (
      <>
        <StatusDot status={status} />
        {STATUS_META[status].label}
      </>
    ),
    name: STATUS_META[status].label,
    value: status,
  }));

/**
 * The Tasks list's Filter sheet (ADR 0013, MMR-724 refinement): Show (the
 * presets, then every live task), Status within it, Priority, Size, Tag, and
 * Sort. Nothing applies until "Show N tasks", which counts what the fields
 * select with the list's own read; Clear resets the fields. Changing Show
 * checks every status that option holds. A status selector a link carried
 * that no Show option holds (`?status=terminal`) stays, with no Show option
 * checked and no Status field, until Show changes. Finished work folds by
 * day, newest first, so it offers no Sort.
 */
export function TaskFilterSheet({
  open,
  onClose,
  project,
  search,
  onApply,
  finalFocus,
}: {
  open: boolean;
  onClose: () => void;
  project: string;
  /** The applied filters, which the fields open on. */
  search: TaskListSearch;
  onApply: (next: TaskListSearch) => void;
  finalFocus?: FinalFocus;
}) {
  const [draft, setDraft] = useState(() => draftOf(search));
  // Each opening starts from what is applied (adjusted while rendering, React's pattern for state from props).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDraft(draftOf(search));
    }
  }

  const next = searchOf(draft, search.q);
  const selectsNothing = draft.statuses.length === 0;
  const count = useQuery({
    ...tasksCountQuery(taskListFilters(next, { project, zone: browserTimeZone() })),
    enabled: open && !selectsNothing,
    placeholderData: keepPreviousData,
  });
  // The tags offered are those of the tasks the Show option holds, before the draft's own narrowing.
  const tagBase = taskListFilters(
    { show: draft.show === 'all' ? undefined : draft.show, status: draft.carried },
    { project, zone: browserTimeZone() },
  );
  const tags = useQuery({ ...taskTagsQuery(tagBase), enabled: open });
  // Tags already applied stay offered, even once no task the Show option holds carries them.
  const tagOptions = [...new Set([...(tags.data ?? []), ...draft.tags])].map((tag) => ({
    label: tag,
    value: tag,
  }));

  // While a changed draft's count loads, the last draft's number is not this one's.
  const counted = count.isPlaceholderData ? undefined : count.data;
  const total = selectsNothing ? 0 : counted;
  const commitLabel =
    total === undefined ? 'Show tasks' : `Show ${String(total)} ${total === 1 ? 'task' : 'tasks'}`;
  const set = (patch: Partial<TaskFilterDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  return (
    <FilterSheet
      open={open}
      onClose={onClose}
      title="Filter tasks"
      finalFocus={finalFocus}
      commitLabel={commitLabel}
      commitDisabled={selectsNothing}
      onCommit={() => {
        onApply(next);
      }}
      onClear={() => {
        setDraft(CLEARED_DRAFT);
      }}
    >
      <FilterPills
        label="Show"
        kind="radio"
        options={SHOW_OPTIONS}
        value={draft.carried === undefined ? [draft.show] : []}
        onChange={([show]) => {
          if (show !== undefined) {
            setDraft((current) => withShow(current, show));
          }
        }}
      />
      {draft.carried === undefined && (
        <FilterPills
          label="Status"
          kind="checkbox"
          options={statusOptions(presetStatuses(draft.show === 'all' ? undefined : draft.show))}
          value={draft.statuses}
          onChange={(statuses) => {
            set({ statuses });
          }}
        />
      )}
      <FilterPills
        label="Priority"
        kind="checkbox"
        mono
        options={PRIORITY_OPTIONS}
        value={draft.priorities}
        onChange={(priorities) => {
          set({ priorities });
        }}
      />
      <FilterPills
        label="Size"
        kind="checkbox"
        mono
        options={SIZE_OPTIONS}
        value={draft.sizes}
        onChange={(sizes) => {
          set({ sizes });
        }}
      />
      {tagOptions.length > 0 && (
        <FilterPills
          label="Tag"
          kind="checkbox"
          options={tagOptions}
          value={draft.tags}
          limit={TAG_LIMIT}
          onChange={(picked) => {
            set({ tags: picked });
          }}
        />
      )}
      {!draftIsFinished(draft) && (
        <FilterSegments
          label="Sort"
          options={SORT_OPTIONS}
          value={draft.sort}
          onChange={(sort) => {
            set({ sort });
          }}
        />
      )}
    </FilterSheet>
  );
}
