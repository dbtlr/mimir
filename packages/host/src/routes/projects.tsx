import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { archivedProjectsQuery } from '../api/shell-queries';
import { reviewQuery } from '../api/view-queries';
import { NewProjectSheet } from '../components/new-project-sheet';
import { OfflineBanner } from '../components/offline-banner';
import { Quiet } from '../components/patterns/feed/quiet';
import { RowGroup } from '../components/patterns/feed/row-group';
import type { RowGroupColumns, RowGroupRow } from '../components/patterns/feed/row-group';
import { ListFold, ListFolds, ListPage } from '../components/patterns/list-page';
import { ActionButton } from '../components/ui/action-button';
import { PlusIcon } from '../components/ui/icons';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { PAGE_COLUMN } from '../lib/page-column';
import {
  archivedInListOrder,
  projectCountLine,
  projectPhoneCount,
  projectSetBack,
  projectsInListOrder,
} from '../lib/project-list';
import type { ListedProject } from '../lib/project-list';

/*
 * `/projects` — the Projects list (ADR 0013 and ADR 0019, MMR-790
 * refinements): every active project as a row of counts on the list page,
 * the ones that need you first, then the most live work, then by name; the
 * archived projects folded after them; New project beside the title. A phone
 * row says one count, a desktop row five under captions. It reads the review
 * entry Home and the sidebar read, so their counts never disagree, and the
 * archived list the switcher reads.
 */

/** The desktop columns, in the order a row's figures give them. */
const COLUMNS: RowGroupColumns = {
  figures: [
    { caption: 'Need you', tone: 'attention' },
    { caption: 'To triage' },
    { caption: 'In flight' },
    { caption: 'Live', tone: 'strong' },
    { caption: 'Going cold' },
  ],
  key: 'Key',
  name: 'Project',
};

const projectLink = (key: string) => ({ params: { key }, to: '/p/$key' }) as const;

/** An active project as a row: its one phone count and its five desktop figures. */
function activeRow(project: ListedProject): RowGroupRow {
  return {
    count: project.needsYou,
    figures: [project.needsYou, project.triage, project.inFlight, project.live, project.goingCold],
    key: project.key,
    name: project.name,
    setBack: projectSetBack(project),
    shows: projectPhoneCount(project),
    to: projectLink(project.key),
  };
}

export function ProjectsPage() {
  const [creating, setCreating] = useState(false);
  const review = useQuery(reviewQuery());
  const archived = useQuery(archivedProjectsQuery);
  const conn = connectivity([review, archived]);

  const active = review.data === undefined ? undefined : projectsInListOrder(review.data.projects);
  const archivedRows: RowGroupRow[] = archivedInListOrder(archived.data ?? []).map((project) => ({
    count: 0,
    key: project.id,
    name: project.title,
    setBack: true,
    shows: { kind: 'none' },
    to: projectLink(project.id),
  }));
  // With nothing active, the page waits for the archive before it says there are no projects.
  const loading = review.isPending || (active?.length === 0 && archived.isPending);
  const empty = active?.length === 0 && archived.data?.length === 0;
  // Either read failing with nothing to show says so, once, where its part would be.
  const unreachable =
    (review.isError && active === undefined) || (archived.isError && archived.data === undefined);

  return (
    <>
      <OfflineBanner {...conn} />
      {/* tabIndex -1: a focus fallback for a control that unmounts itself (focusMain). */}
      <main
        tabIndex={-1}
        className={cn('min-h-0 flex-1 overflow-y-auto', conn.offline && 'offline-demoted')}
      >
        <div className={cn(PAGE_COLUMN, 'px-3.5 pt-4 pb-10 md:px-5 md:pt-6 md:pb-12')}>
          <header className="mb-1 flex items-center justify-between gap-4">
            <h1 className="m-0 text-page leading-9 font-bold text-ink-bright">Projects</h1>
            {/* The 44 button is pulled back to the title's 36 line, so the title sets the gap below. */}
            <ActionButton
              size="header"
              variant="pageOutline"
              className="gap-2 max-md:-my-1"
              disabled={conn.offline}
              onClick={() => {
                setCreating(true);
              }}
            >
              <PlusIcon className="size-4 text-ink-dim" />
              New project
            </ActionButton>
          </header>
          <ListPage
            label="Projects"
            count={loading ? undefined : active && projectCountLine(active.length)}
          >
            {loading && <Skeleton className="h-40" />}
            {empty && <Quiet>No projects yet.</Quiet>}
            {active !== undefined && active.length > 0 && (
              <RowGroup
                label="Active projects"
                rows={active.map(activeRow)}
                keepZero
                columns={COLUMNS}
              />
            )}
            {unreachable && (
              <p className="mt-8 text-meta text-status-blocked-foreground first:mt-0">
                Unreachable — is the Mimir host running?
              </p>
            )}
            {archivedRows.length > 0 && (
              <ListFolds>
                {/* The archived projects, closed until opened: each row its key and name, set back. */}
                <ListFold label="Archived" count={archivedRows.length}>
                  <RowGroup label="Archived projects" rows={archivedRows} keepZero />
                </ListFold>
              </ListFolds>
            )}
          </ListPage>
        </div>
      </main>
      <NewProjectSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}
