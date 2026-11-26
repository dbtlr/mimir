import type { EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';

import { usePendingPins } from '../api/shell-mutations';
import { projectsQuery } from '../api/shell-queries';
import { reviewQuery } from '../api/view-queries';
import { cn } from '../lib/cn';
import { groupProjects, overlayPins, sidebarShortlist } from '../lib/project-switcher';
import { DRAWER_TAP_ROW } from '../lib/touch-target';
import { FEED_LINK_TEXT } from './patterns/feed/link';
import { PROJECT_ROW, ProjectRowContent } from './project-options';
import { ROW_CURRENT } from './sidebar-selection';

/*
 * The All projects sidebar's Projects section (MMR-562, MMR-567; ADR 0013
 * refinements): the pinned projects as links, so each is one click from `/`.
 * With none pinned it lists the most recently active few. It ends in See all,
 * a link to the Projects list (MMR-790). Finding any other project by name is
 * the switcher's job, in the header above.
 */

/** A row: a link to the project's work page. */
function ProjectLink({
  project,
  needsYou,
  onNavigate,
}: {
  project: EngineNode;
  needsYou: number;
  onNavigate?: () => void;
}) {
  return (
    <li>
      <Link
        to="/p/$key"
        params={{ key: project.id }}
        onClick={onNavigate}
        data-project={project.id}
        className={cn(
          PROJECT_ROW,
          DRAWER_TAP_ROW,
          'transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent',
        )}
      >
        <ProjectRowContent project={project} needsYou={needsYou} />
      </Link>
    </li>
  );
}

/**
 * The section's last row: "See all 11 projects", in the See all treatment, a
 * link to `/projects` that takes the selection while there. Its words start
 * where the rows' keys do, past the status dot's 8.
 */
function SeeAllProjects({ count, onNavigate }: { count: number; onNavigate?: () => void }) {
  return (
    <Link
      to="/projects"
      onClick={onNavigate}
      className={cn(
        PROJECT_ROW,
        DRAWER_TAP_ROW,
        FEED_LINK_TEXT,
        'font-medium transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent',
        ROW_CURRENT,
      )}
    >
      <span aria-hidden="true" className="w-2 shrink-0" />
      See all {count.toLocaleString('en-US')} {count === 1 ? 'project' : 'projects'}
    </Link>
  );
}

/** The Projects section. `onNavigate` fires when a pick moves the page, so the drawer can close. */
export function SidebarProjects({ onNavigate }: { onNavigate?: () => void }) {
  const headingId = useId();
  const projects = useQuery(projectsQuery);
  const review = useQuery(reviewQuery());
  const pendingPins = usePendingPins();
  const needsYou = new Map(review.data?.projects.map((p) => [p.key, p.needsYou]));
  // A pin in flight shows as already made; the server's list catches up on settle.
  const groups = groupProjects(overlayPins(projects.data ?? [], pendingPins));
  const rows = sidebarShortlist(groups);
  // A remembered project frames the sidebar before the list arrives, so a
  // failed first read still has a section to say so in.
  const failed = rows.length === 0 && projects.isError;
  if (rows.length === 0 && !failed) {
    return null;
  }
  return (
    <section aria-labelledby={headingId} className="mt-3 flex flex-col gap-0.5">
      <h2 id={headingId} className="microlabel px-2 pb-1 text-ink-dim">
        Projects
      </h2>
      {failed ? (
        <p className="px-2 py-1 text-xs text-ink-dim">Couldn’t load the projects.</p>
      ) : (
        <>
          <ul aria-label={groups.pinned.length > 0 ? 'Pinned projects' : 'Recent projects'}>
            {rows.map((p) => (
              <ProjectLink
                key={p.id}
                project={p}
                needsYou={needsYou.get(p.id) ?? 0}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
          {projects.data !== undefined && (
            <SeeAllProjects count={projects.data.length} onNavigate={onNavigate} />
          )}
        </>
      )}
    </section>
  );
}
