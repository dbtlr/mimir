import type { EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';

import { usePendingPins } from '../api/shell-mutations';
import { projectsQuery } from '../api/shell-queries';
import { reviewQuery } from '../api/view-queries';
import { cn } from '../lib/cn';
import { homeShortlist, overlayPins } from '../lib/project-switcher';
import { FEED_LINK_TEXT } from './patterns/feed/link';
import { ProjectRowContent } from './project-options';
import { CHILD_INDENT, ContainerRowLink } from './sidebar-containers';
import { ROW_CURRENT, SIDEBAR_ROW } from './sidebar-selection';
import { Skeleton } from './ui/skeleton';

/*
 * Home's level of the sidebar (ADR 0013, MMR-730 refinement): Home is the
 * root, its row counting the active projects, and its children are the
 * projects, the ones that need the operator first, then pinned, then the most
 * recently active, six in all. See all leads to the Projects list (MMR-790).
 * Finding any other project by name is the switcher's job, above.
 */

/** A project's row: a link to its page, with the switcher row's dot, key, and name. */
function ProjectLink({
  project,
  needsYou,
  onNavigate,
}: {
  project: EngineNode;
  needsYou: number;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <li className="flex flex-col">
      <Link
        to="/p/$key"
        params={{ key: project.id }}
        onClick={onNavigate}
        data-project={project.id}
        className={cn(SIDEBAR_ROW, CHILD_INDENT, 'hover:text-ink-bright')}
      >
        <ProjectRowContent project={project} needsYou={needsYou} />
      </Link>
    </li>
  );
}

/**
 * The list's last row: "See all 11 projects", in the See all treatment, a
 * link to `/projects` that is the page while there. Its words start where the
 * rows' keys do, past the status dot's 8.
 */
function SeeAllProjects({
  count,
  onNavigate,
}: {
  count: number;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <Link
      to="/projects"
      onClick={onNavigate}
      className={cn(SIDEBAR_ROW, CHILD_INDENT, FEED_LINK_TEXT, 'font-medium', ROW_CURRENT)}
    >
      <span aria-hidden="true" className="w-2 shrink-0" />
      See all {count.toLocaleString('en-US')} {count === 1 ? 'project' : 'projects'}
    </Link>
  );
}

/**
 * Home's container list: the Home row, washed on `/` and ringed on every other
 * page outside a project, then the projects. `onNavigate` fires when a pick
 * moves the page, so the drawer can close behind it.
 */
export function HomeContainers({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const projects = useQuery(projectsQuery);
  const review = useQuery(reviewQuery());
  const pendingPins = usePendingPins();
  const needsYou = new Map(review.data?.projects.map((p) => [p.key, p.needsYou]));
  const listed = projects.data;
  const loaded = () => {
    if (listed === undefined) {
      return projects.isError ? (
        <p className="px-2 py-1.5 text-xs text-ink-dim">Couldn’t load the projects.</p>
      ) : (
        <Skeleton aria-busy="true" className="mx-2 my-1 ml-6 h-24" />
      );
    }
    // A pin in flight shows as already made; the server's list catches up on settle.
    const rows = homeShortlist(overlayPins(listed, pendingPins), needsYou);
    return (
      <>
        <ul aria-label="Projects" className="flex flex-col gap-px">
          {rows.map((p) => (
            <ProjectLink
              key={p.id}
              project={p}
              needsYou={needsYou.get(p.id) ?? 0}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
        <SeeAllProjects count={listed.length} onNavigate={onNavigate} />
      </>
    );
  };
  return (
    <>
      <ContainerRowLink
        target={{ to: '/' }}
        mark={pathname === '/' ? 'page' : 'holds'}
        title="Home"
        tally={listed === undefined ? undefined : listed.length.toLocaleString('en-US')}
        tallyName={
          listed === undefined
            ? undefined
            : `${listed.length.toLocaleString('en-US')} ${listed.length === 1 ? 'project' : 'projects'}`
        }
        onNavigate={onNavigate}
      />
      {loaded()}
    </>
  );
}
