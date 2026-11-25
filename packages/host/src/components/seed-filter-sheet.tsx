import type { SeedKind } from '@mimir/contract';
import { useState } from 'react';

import type { EngineSeed } from '../api/browse-queries';
import {
  CLEARED_SEED_DRAFT,
  seedDraftOf,
  seedSearchOf,
  seedsInView,
  seedsMatching,
} from '../lib/seed-list';
import type { SeedFilterDraft, SeedListSearch } from '../lib/seed-list';
import { FilterPills, FilterSegments, FilterSheet } from './patterns/filter-sheet';
import type { FilterOption } from './patterns/filter-sheet';
import type { FinalFocus } from './patterns/opener';

/** Show's five segments: every lane, then the two presets and the two lanes set aside. */
const SHOW_OPTIONS: { value: SeedFilterDraft['show']; label: string }[] = [
  { label: 'All', value: 'all' },
  { label: 'To triage', value: 'to-triage' },
  { label: 'To resolve', value: 'ready-to-resolve' },
  { label: 'Parked', value: 'parked' },
  { label: 'Settled', value: 'settled' },
];

/** A seed's kinds, in sentence case as the seed form names them (MMR-743). */
const KIND_OPTIONS: FilterOption<SeedKind>[] = [
  { label: 'Idea', value: 'idea' },
  { label: 'Bug', value: 'bug' },
  { label: 'Feature', value: 'feature' },
];

/**
 * The Seeds list's Filter sheet (ADR 0013, MMR-725 refinement): Show (every
 * lane, a preset, or a lane set aside) and Kind (any of them). Nothing applies
 * until "Show N seeds", which counts what the list would show from the seeds
 * it already holds, so it answers at once ("Show seeds" until they load);
 * Clear resets the fields.
 */
export function SeedFilterSheet({
  open,
  onClose,
  seeds,
  search,
  onApply,
  finalFocus,
}: {
  open: boolean;
  onClose: () => void;
  /** The project's every seed, as the list read them; undefined until they load. */
  seeds: readonly EngineSeed[] | undefined;
  /** The applied filters, which the fields open on. */
  search: SeedListSearch;
  onApply: (next: SeedListSearch) => void;
  finalFocus?: FinalFocus;
}) {
  const [draft, setDraft] = useState(() => seedDraftOf(search));
  // Each opening starts from what is applied (adjusted while rendering, React's pattern for state from props).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDraft(seedDraftOf(search));
    }
  }

  const next = seedSearchOf(draft, search.q);
  const total =
    seeds === undefined
      ? undefined
      : seedsInView(seedsMatching(seeds, { kind: next.kind, q: next.q ?? '' }), next.show).length;
  const commitLabel =
    total === undefined
      ? 'Show seeds'
      : `Show ${total.toLocaleString('en-US')} ${total === 1 ? 'seed' : 'seeds'}`;

  return (
    <FilterSheet
      open={open}
      onClose={onClose}
      title="Filter seeds"
      finalFocus={finalFocus}
      commitLabel={commitLabel}
      onCommit={() => {
        onApply(next);
      }}
      onClear={() => {
        setDraft(CLEARED_SEED_DRAFT);
      }}
    >
      <FilterSegments
        fit
        label="Show"
        options={SHOW_OPTIONS}
        value={draft.show}
        onChange={(show) => {
          setDraft((current) => ({ ...current, show }));
        }}
      />
      <FilterPills
        label="Kind"
        kind="checkbox"
        options={KIND_OPTIONS}
        value={draft.kinds}
        onChange={(kinds) => {
          setDraft((current) => ({ ...current, kinds }));
        }}
      />
    </FilterSheet>
  );
}
