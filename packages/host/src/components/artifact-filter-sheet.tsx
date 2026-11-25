import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { artifactsCountQuery } from '../api/browse-queries';
import { artifactListFilters, chosenKind } from '../lib/artifact-list';
import type { ArtifactListSearch } from '../lib/artifact-list';
import { kindTagOptions } from '../lib/artifacts';
import { FilterPills, FilterSheet } from './patterns/filter-sheet';
import type { FinalFocus } from './patterns/opener';

/** The Kind field's value for no kind. */
const ANY = '';

/**
 * The URL a kind applies as: the kind's tag, or with no kind the plain tag a
 * link carried, which keeps its own chip. The read takes one tag, so a kind
 * replaces it.
 */
function searchWithKind(search: ArtifactListSearch, kind: string): ArtifactListSearch {
  const { tag: _tag, ...rest } = search;
  if (kind !== ANY) {
    return { ...rest, tag: kind };
  }
  const carried = chosenKind(search) === undefined ? search.tag : undefined;
  return carried === undefined ? rest : { ...rest, tag: carried };
}

/**
 * The Artifacts list's Filter sheet (ADR 0013, MMR-725 refinement): Kind, one
 * choice, since an artifact's kind is a tag and the read takes one. Nothing
 * applies until "Show N artifacts", which counts with the list's own read;
 * Clear goes back to any kind.
 */
export function ArtifactFilterSheet({
  open,
  onClose,
  project,
  search,
  rowTags,
  onApply,
  finalFocus,
}: {
  open: boolean;
  onClose: () => void;
  project: string;
  /** The applied filters, which the field opens on. */
  search: ArtifactListSearch;
  /** The loaded rows' tags, whose `kind:` tags the field offers too. */
  rowTags: readonly (readonly string[])[];
  onApply: (next: ArtifactListSearch) => void;
  finalFocus?: FinalFocus;
}) {
  const [kind, setKind] = useState(() => chosenKind(search) ?? ANY);
  // Each opening starts from what is applied (adjusted while rendering, React's pattern for state from props).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setKind(chosenKind(search) ?? ANY);
    }
  }

  const next = searchWithKind(search, kind);
  const count = useQuery({
    ...artifactsCountQuery(artifactListFilters(next, project)),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const total = count.isPlaceholderData ? undefined : count.data;
  const commitLabel =
    total === undefined
      ? 'Show artifacts'
      : `Show ${total.toLocaleString('en-US')} ${total === 1 ? 'artifact' : 'artifacts'}`;

  return (
    <FilterSheet
      open={open}
      onClose={onClose}
      title="Filter artifacts"
      finalFocus={finalFocus}
      commitLabel={commitLabel}
      onCommit={() => {
        onApply(next);
      }}
      onClear={() => {
        setKind(ANY);
      }}
    >
      <FilterPills
        label="Kind"
        kind="radio"
        options={[
          { label: 'Any kind', value: ANY },
          ...kindTagOptions(rowTags, chosenKind(search)).map((o) => ({
            label: o.label,
            value: o.tag,
          })),
        ]}
        value={[kind]}
        onChange={([picked]) => {
          setKind(picked ?? ANY);
        }}
      />
    </FilterSheet>
  );
}
