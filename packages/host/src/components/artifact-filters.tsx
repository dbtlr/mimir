import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { ArtifactFilters as Filters } from '../api/browse-queries';
import { kindTagLabel, kindTagOptions } from '../lib/artifacts';
import { BrowserSearch, FilterRow, MenuChip, RemovableChip } from './browser-list';

/** Delay before a paused search push reaches the URL/query (one round-trip per pause, not per keystroke). */
const SEARCH_DEBOUNCE_MS = 250;

/** The filters with no menu of their own: URL-addressable, shown as removable chips. */
const REMOVABLE: { key: Exclude<keyof Filters, 'project'>; label: (v: string) => string }[] = [
  { key: 'tag', label: (v) => `tag ${v}` },
  { key: 'atOrAfter', label: (v) => `on or after ${v}` },
  { key: 'atOrBefore', label: (v) => `on or before ${v}` },
];

/**
 * The artifact browser's filter row (MMR-454): a title search and a kind
 * menu. `onChange` carries the single changed field; the page
 * merges it into the search params (an empty string clears that filter).
 * Dates and a non-kind `tag` have no menu; when the URL carries them they
 * render as removable accent chips.
 *
 * The search box is controlled by local state and **debounced**: keystrokes
 * update the box immediately but only push `q` once typing pauses. An
 * externally-changed `q` (Back/Forward) re-syncs the box.
 */
export function ArtifactFilters({
  filters,
  rowTags,
  onChange,
}: {
  /** The set filters; the path names the project, so the chips never edit it. */
  filters: Omit<Filters, 'project'>;
  /** The loaded rows' tags — the kind menu offers the kinds they show. */
  rowTags: readonly (readonly string[])[];
  onChange: (partial: Partial<Omit<Filters, 'project'>>) => void;
}) {
  const [q, setQ] = useState(filters.q ?? '');

  // Re-sync during render when `q` changes from outside. When our own debounced
  // push lands, filters.q already equals q, so the box keeps its value.
  const [syncedQ, setSyncedQ] = useState(filters.q);
  if (filters.q !== syncedQ) {
    setSyncedQ(filters.q);
    setQ(filters.q ?? '');
  }

  // Call the latest onChange without re-arming the timer on every parent render.
  const pushQ = useEffectEvent((value: string) => {
    onChange({ q: value });
  });

  useEffect(() => {
    if (q === (filters.q ?? '')) {
      return undefined;
    }
    const t = setTimeout(() => {
      pushQ(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [q, filters.q]);

  // Focus handoff on chip removal: the activated button unmounts, which would
  // drop keyboard focus to <body>. Focus hops to the search box first.
  const searchRef = useRef<HTMLDivElement>(null);

  const chosenKind = filters.tag === undefined ? undefined : kindTagLabel(filters.tag);
  const removable = REMOVABLE.flatMap(({ key, label }) => {
    const value = filters[key];
    if (value === undefined || value === '') {
      return [];
    }
    // A kind tag is the kind menu's, not a removable chip.
    if (key === 'tag' && chosenKind !== undefined) {
      return [];
    }
    return [{ key, label: label(value) }];
  });

  return (
    <FilterRow>
      <div ref={searchRef} className="flex min-w-0 flex-[1_1_260px]">
        <BrowserSearch
          value={q}
          onChange={setQ}
          label="Search artifacts"
          placeholder="Search titles…"
        />
      </div>
      <MenuChip
        label={chosenKind ?? 'Any kind'}
        on={chosenKind !== undefined}
        options={[
          { label: 'Any kind', value: '' },
          ...kindTagOptions(rowTags, filters.tag).map((o) => ({ label: o.label, value: o.tag })),
        ]}
        onSelect={(tag) => {
          onChange({ tag });
        }}
      />
      {removable.map((chip) => (
        <RemovableChip
          key={chip.key}
          label={chip.label}
          removeLabel={`Remove filter ${chip.label}`}
          onRemove={() => {
            searchRef.current?.querySelector('input')?.focus();
            onChange({ [chip.key]: '' });
          }}
        />
      ))}
    </FilterRow>
  );
}
