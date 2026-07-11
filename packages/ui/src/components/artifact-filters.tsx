import { useEffect, useRef, useState } from 'react';

import type { ArtifactFilters as Filters } from '../api/queries';
import { cn } from '../lib/cn';

/** Delay before a paused search push reaches the URL/query (one round-trip per pause, not per keystroke). */
const SEARCH_DEBOUNCE_MS = 250;

/** The removable-chip renderings of the non-search filters. */
const CHIP_FIELDS: {
  key: keyof Filters;
  clear: Partial<Filters>;
  label: (v: string) => string;
}[] = [
  { clear: { project: '' }, key: 'project', label: (v) => v },
  { clear: { tag: '' }, key: 'tag', label: (v) => v },
  { clear: { since: '' }, key: 'since', label: (v) => `since ${v}` },
  { clear: { before: '' }, key: 'before', label: (v) => `before ${v}` },
];

const fieldInput =
  'rounded border border-line bg-well-900 px-2 py-1 text-xs text-ink outline-none focus-visible:border-accent';

/**
 * The artifact-browser filter block (Meridian 16a): a labeled title+body
 * search over removable filter chips. `onChange` carries the single changed
 * field; the page merges it into the search params (an empty string clears
 * that filter) via a history-replacing navigation.
 *
 * The Search input is controlled by local state and **debounced**: keystrokes
 * update the box immediately but only push `q` to the URL/query once typing
 * pauses. Because it's controlled, an externally-changed `q` (Back/Forward, a
 * future "clear filters") re-syncs the box. Active project/tag/since/before
 * filters render as accent-wash chips with ✕ removal; `+ filter` unfolds the
 * field editors.
 */
export function ArtifactFilters({
  filters,
  projects,
  onChange,
}: {
  filters: Filters;
  projects: string[];
  onChange: (partial: Partial<Filters>) => void;
}) {
  // Local, immediate value for the search box; the URL trails it by the debounce.
  const [q, setQ] = useState(filters.q ?? '');
  const [adding, setAdding] = useState(false);

  // Focus handoff on chip removal: the activated ✕ button unmounts, which would
  // drop keyboard focus to <body>. Before the removal lands, focus hops to a
  // surviving neighbor chip (next, else previous), falling back to `+ filter`.
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const addFilterRef = useRef<HTMLButtonElement>(null);

  // Re-sync when `q` changes from outside (Back/Forward, clear-filters). When our
  // own debounced push lands, filters.q already equals q, so this is a no-op.
  useEffect(() => {
    setQ(filters.q ?? '');
  }, [filters.q]);

  // Keep the latest onChange without re-arming the timer on every parent render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Push the paused value up once, after the debounce window.
  useEffect(() => {
    if (q === (filters.q ?? '')) {
      return undefined;
    }
    const t = setTimeout(() => onChangeRef.current({ q }), SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [q, filters.q]);

  const chips = CHIP_FIELDS.flatMap(({ key, clear, label }) => {
    const value = filters[key];
    return value === undefined || value === '' ? [] : [{ clear, key, label: label(value) }];
  });

  return (
    <div className="flex flex-col gap-2 px-3 pb-2.5">
      <label className="flex items-center gap-2 rounded-[9px] border border-line-bright bg-well-900 px-3 py-2 focus-within:border-accent">
        <span aria-hidden className="text-meta text-ink-faint select-none">
          ⌕
        </span>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
          }}
          aria-label="Search title + body (substring)"
          placeholder="Search title + body (substring)"
          className="w-full bg-transparent text-[0.78125rem] text-ink outline-none placeholder:text-ink-faint"
        />
      </label>

      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip, i) => (
          <button
            key={chip.key}
            type="button"
            ref={(el) => {
              if (el === null) {
                chipRefs.current.delete(chip.key);
              } else {
                chipRefs.current.set(chip.key, el);
              }
            }}
            aria-label={`Remove filter ${chip.label}`}
            onClick={() => {
              const neighbor = chips[i + 1] ?? chips[i - 1];
              const target =
                neighbor === undefined ? addFilterRef.current : chipRefs.current.get(neighbor.key);
              target?.focus();
              onChange(chip.clear);
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent/9 px-2.5 py-1 font-mono text-tag font-semibold text-accent-foreground inset-ring inset-ring-accent/20 transition-colors hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="max-w-32 truncate">{chip.label}</span>
            <span aria-hidden>✕</span>
          </button>
        ))}
        <button
          type="button"
          ref={addFilterRef}
          aria-expanded={adding}
          onClick={() => {
            setAdding((v) => !v);
          }}
          className={cn(
            'inline-flex items-center rounded-full px-2.5 py-1 text-tag text-ink-dim inset-ring inset-ring-line-bright',
            'transition-colors hover:bg-well-800 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent',
            adding && 'bg-well-800 text-ink',
          )}
        >
          + filter
        </button>
      </div>

      {adding && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-well-850 p-2.5">
          <label className="flex flex-col gap-0.5 text-tag text-ink-dim">
            Project
            <select
              value={filters.project ?? ''}
              onChange={(e) => {
                onChange({ project: e.target.value });
              }}
              className={fieldInput}
            >
              <option value="">All</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5 text-tag text-ink-dim">
            Tag
            <input
              value={filters.tag ?? ''}
              onChange={(e) => {
                onChange({ tag: e.target.value });
              }}
              placeholder="kind:spec"
              className={cn(fieldInput, 'w-28')}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-tag text-ink-dim">
            Since
            <input
              type="date"
              value={filters.since ?? ''}
              onChange={(e) => {
                onChange({ since: e.target.value });
              }}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-tag text-ink-dim">
            Before
            <input
              type="date"
              value={filters.before ?? ''}
              onChange={(e) => {
                onChange({ before: e.target.value });
              }}
              className={fieldInput}
            />
          </label>
        </div>
      )}
    </div>
  );
}
