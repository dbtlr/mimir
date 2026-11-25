import { useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { ARTIFACT_PAGE_SIZE, artifactsQuery } from '../api/browse-queries';
import type { ArtifactSummary } from '../api/browse-queries';
import { browserTimeZone } from '../api/queries';
import { ArtifactFilterSheet } from '../components/artifact-filter-sheet';
import { BrowserSearch } from '../components/browser-list';
import { DayFolds, FinishedRow } from '../components/patterns/feed/day-fold';
import { Quiet } from '../components/patterns/feed/quiet';
import { FilterChip, ListPage, ListShowMore, PresetChip } from '../components/patterns/list-page';
import { ProjectFrame } from '../components/project-frame';
import { Skeleton } from '../components/ui/skeleton';
import {
  artifactCountLine,
  artifactListFilters,
  carriedChips,
  chosenKind,
} from '../lib/artifact-list';
import type { ArtifactListSearch } from '../lib/artifact-list';
import { kindName, splitKindTags } from '../lib/artifacts';
import { foldByDay } from '../lib/day-folds';
import { artifactLink } from '../lib/record-url';
import { useListWindow } from '../lib/use-list-window';
import { useSearchText } from '../lib/use-search-text';
import { shippedTime } from '../lib/work-page';
import { artifactsRoute } from '../router';

/** Rows a day shows before its Show N more (DESIGN.md, List page). */
const DAY_CAP = 5;

/** How many attached records a row names before folding the rest into `+N`. */
const MAX_LINKS = 3;

/**
 * An artifact row's one meta line: the kind as a word, then the records it is
 * attached to ("On MMR-717, MMR-724"), three at most and the rest as "+2", so
 * the line keeps to one; the records' list gives way first when it runs out of
 * room, and the count stays.
 */
function artifactMeta(artifact: ArtifactSummary): ReactElement | undefined {
  const { kind } = splitKindTags(artifact.tags);
  const shown = artifact.links.slice(0, MAX_LINKS);
  const more = artifact.links.length - shown.length;
  if (kind === undefined && shown.length === 0) {
    return undefined;
  }
  return (
    <>
      {kind !== undefined && <span className="shrink-0 text-ink">{kindName(kind)}</span>}{' '}
      {shown.length > 0 && (
        <span className="min-w-0 truncate">
          On{' '}
          {shown.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <span className="font-mono">{id}</span>
            </span>
          ))}
        </span>
      )}
      {more > 0 && (
        <>
          {' '}
          <span className="shrink-0">+{more}</span>
        </>
      )}
    </>
  );
}

/** One artifact as a fold's row: its title, its kind and records, and when it was frozen. */
function artifactRow(artifact: ArtifactSummary, zone: string): ReactElement {
  return (
    <FinishedRow
      key={artifact.id}
      variant="artifact"
      to={artifactLink(artifact.id)}
      title={artifact.title}
      meta={artifactMeta(artifact)}
      time={shippedTime(artifact.createdAt, zone)}
    />
  );
}

/**
 * `/p/KEY/artifacts`: the Artifacts list (ADR 0013, MMR-725 refinement; ADR
 * 0019's list page). The count line, the search, Filter (the kind) and the
 * chips of a tag or dates a link carries, then the artifacts newest first,
 * folded by the day they were frozen with only the newest day open. The list
 * loads by window, with Show N more at its foot. Every filter is in the URL
 * (`tag`, `q`, `atOrAfter`, `atOrBefore`), so a link opens the same list.
 */
export function ArtifactsPage() {
  const navigate = useNavigate();
  const { key: project } = artifactsRoute.useParams();
  const search = artifactsRoute.useSearch();
  const zone = browserTimeZone();
  const filters = artifactListFilters(search, project);

  const { read, shown, hasMore, loadingMore, loadMoreFailed, loadMore } = useListWindow(
    filters,
    (windows) => artifactsQuery(filters, windows),
  );
  const loaded = shown?.items;
  const searchRef = useRef<HTMLDivElement>(null);
  const filterChip = useRef<HTMLButtonElement>(null);
  const [filtering, setFiltering] = useState(false);

  const apply = (next: ArtifactListSearch) =>
    void navigate({
      params: { key: project },
      replace: true,
      search: next,
      to: '/p/$key/artifacts',
    });

  const [q, setQ] = useSearchText(search.q, (value) => {
    const { q: _q, ...rest } = search;
    apply(value === '' ? rest : { ...rest, q: value });
  });

  const days = useMemo(
    () =>
      foldByDay(loaded ?? [], {
        at: (artifact) => artifact.createdAt,
        row: (artifact) => artifactRow(artifact, zone),
        zone,
      }),
    [loaded, zone],
  );
  const narrowed = Object.values(search).some((value) => value !== undefined);

  return (
    <ProjectFrame projectKey={project} tab="artifacts" reads={[read]}>
      <ListPage
        label="Artifacts"
        count={shown !== undefined && artifactCountLine(shown.items.length, shown.total)}
        search={
          <div ref={searchRef}>
            <BrowserSearch
              value={q}
              onChange={setQ}
              label="Search artifacts"
              placeholder="Search titles and IDs"
            />
          </div>
        }
        chips={
          <>
            <FilterChip
              ref={filterChip}
              open={filtering}
              applied={chosenKind(search) === undefined ? 0 : 1}
              onClick={() => {
                setFiltering(true);
              }}
            />
            {carriedChips(search, { zone }).map((chip) => (
              <PresetChip
                key={chip.key}
                label={`${chip.lead} ${chip.value}`}
                onRemove={() => {
                  searchRef.current?.querySelector('input')?.focus();
                  const { [chip.key]: _removed, ...rest } = search;
                  apply(rest);
                }}
              >
                {chip.lead}{' '}
                {chip.mono ? (
                  <span className="font-mono [font-size-adjust:var(--mono-adjust)]">
                    {chip.value}
                  </span>
                ) : (
                  chip.value
                )}
              </PresetChip>
            ))}
          </>
        }
      >
        {read.isPending && loaded === undefined && <Skeleton className="h-40" />}
        {read.isError && loaded === undefined && (
          <p className="text-meta text-status-blocked-foreground">
            Unreachable — is the Mimir host running?
          </p>
        )}
        {loaded !== undefined && loaded.length === 0 && (
          <Quiet>{narrowed ? 'No artifacts match.' : 'No artifacts yet.'}</Quiet>
        )}
        {days.length > 0 && <DayFolds days={days} cap={DAY_CAP} />}
        {hasMore && shown !== undefined && (
          <ListShowMore
            count={Math.min(ARTIFACT_PAGE_SIZE, shown.total - shown.items.length)}
            noun="artifacts"
            loading={loadingMore}
            failed={loadMoreFailed}
            onClick={loadMore}
          />
        )}
      </ListPage>
      <ArtifactFilterSheet
        open={filtering}
        onClose={() => {
          setFiltering(false);
        }}
        project={project}
        search={search}
        rowTags={(loaded ?? []).map((artifact) => artifact.tags)}
        finalFocus={() => filterChip.current}
        onApply={apply}
      />
    </ProjectFrame>
  );
}
