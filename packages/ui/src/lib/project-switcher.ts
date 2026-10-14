import type { WireNode } from '../api/types';
import { orderProjects } from './current-project';
import { isSectionPage, sectionOfPath } from './project-sidebar';
import type { SidebarSection } from './project-sidebar';

/*
 * What the project switcher (MMR-497) reads: how it groups and filters the
 * project list, and where picking a project lands.
 */

type Switchable = Pick<WireNode, 'id' | 'title' | 'archived_at'> & {
  pinned?: boolean | null;
  last_activity_at?: string | null;
};

/**
 * The active projects in the switcher's two groups: the pinned ones, then the
 * rest. Each keeps `orderProjects`' order, so most recent activity comes first.
 */
export function groupProjects<T extends Switchable>(
  projects: readonly T[],
): { pinned: T[]; rest: T[] } {
  const ordered = orderProjects(projects);
  return {
    pinned: ordered.filter((p) => p.pinned === true),
    rest: ordered.filter((p) => p.pinned !== true),
  };
}

/** The projects whose key or title contains the query, ignoring case; an empty query keeps all. */
export function filterProjects<T extends Pick<WireNode, 'id' | 'title'>>(
  projects: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return [...projects];
  }
  return projects.filter(
    (p) => p.id.toLowerCase().includes(needle) || p.title.toLowerCase().includes(needle),
  );
}

const SECTION_ROUTES = {
  artifacts: '/p/$key/artifacts',
  seeds: '/p/$key/seeds',
  tasks: '/p/$key/tasks',
  work: '/p/$key',
} as const satisfies Record<SidebarSection, string>;

/**
 * Where picking project `key` goes from `pathname`: the same section of the
 * new project when the page is a section's own route (`/p/A/tasks` to
 * `/p/B/tasks`), else its work page — a record belongs to the old project, so
 * the page has no counterpart.
 */
export function projectSwitchTarget(
  pathname: string,
  key: string,
): { to: (typeof SECTION_ROUTES)[SidebarSection]; params: { key: string } } {
  const section = isSectionPage(pathname) ? sectionOfPath(pathname) : undefined;
  return { params: { key }, to: SECTION_ROUTES[section ?? 'work'] };
}
