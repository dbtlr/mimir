import type { EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';

import { usePendingPins } from '../api/shell-mutations';
import { projectsQuery } from '../api/shell-queries';
import { reviewQuery } from '../api/view-queries';
import { cn } from '../lib/cn';
import { groupProjects, overlayPins, sidebarShortlist } from '../lib/project-switcher';
import { PROJECT_ROW, ProjectRowContent } from './project-options';

/*
 * The All projects sidebar's Projects section (MMR-562, MMR-567; ADR 0013
 * refinements): the pinned projects as links, so each is one click from `/`.
 * With none pinned it lists the most recently active few. Finding any other
 * project is the switcher's job, in the header above.
 */

/** A row: a link to the project's work page. */
function ProjectLink({
  project,
  decisions,
  onNavigate,
}: {
  project: EngineNode;
  decisions: number;
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
          'transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent',
        )}
      >
        <ProjectRowContent project={project} decisions={decisions} />
      </Link>
    </li>
  );
}

/** The Projects section. `onNavigate` fires when a pick moves the page, so the drawer can close. */
export function SidebarProjects({ onNavigate }: { onNavigate?: () => void }) {
  const headingId = useId();
  const projects = useQuery(projectsQuery);
  const review = useQuery(reviewQuery());
  const pendingPins = usePendingPins();
  const decisions = new Map(review.data?.projects.map((p) => [p.key, p.decisions]));
  // A pin in flight shows as already made; the server's list catches up on settle.
  const groups = groupProjects(overlayPins(projects.data ?? [], pendingPins));
  const rows = sidebarShortlist(groups);
  if (rows.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={headingId} className="mt-3 flex flex-col gap-0.5">
      <h2 id={headingId} className="microlabel px-2 pb-1 text-ink-faint">
        Projects
      </h2>
      <ul aria-label={groups.pinned.length > 0 ? 'Pinned projects' : 'Recent projects'}>
        {rows.map((p) => (
          <ProjectLink
            key={p.id}
            project={p}
            decisions={decisions.get(p.id) ?? 0}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </section>
  );
}
