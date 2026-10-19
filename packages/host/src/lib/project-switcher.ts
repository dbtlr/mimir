import type { EngineNode } from '@mimir/contract';

import { orderProjects } from './current-project';
import { isSectionPage, sectionOfPath } from './project-sidebar';
import type { SidebarSection } from './project-sidebar';

/*
 * What the project switcher (MMR-497) reads: how it groups and filters the
 * project list, and where picking a project lands.
 */

/**
 * The switcher's highlight key for its All projects option (MMR-505). A project
 * key is letters only, so this cannot name a project.
 */
export const ALL_PROJECTS_KEY = '*';

type Switchable = Pick<EngineNode, 'id' | 'title' | 'archivedAt' | 'pinned' | 'lastActivityAt'>;

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

/** How many projects the All projects sidebar lists when none is pinned. */
const SHORTLIST_FALLBACK = 5;

/**
 * What the All projects sidebar lists (MMR-562): the pinned projects, or with
 * none pinned the most recently active few.
 */
export function sidebarShortlist<T>(groups: { pinned: readonly T[]; rest: readonly T[] }): T[] {
  return groups.pinned.length > 0 ? [...groups.pinned] : groups.rest.slice(0, SHORTLIST_FALLBACK);
}

/** One project carrying the pin it is on its way to, if it has one in flight. */
function withPendingPin<T extends Pick<EngineNode, 'id' | 'pinned'>>(
  project: T,
  pins: ReadonlyMap<string, boolean>,
): T {
  const pinned = pins.get(project.id);
  return pinned === undefined ? project : { ...project, pinned };
}

/** The list with every pin in flight laid over what the server last said. */
export function overlayPins<T extends Pick<EngineNode, 'id' | 'pinned'>>(
  projects: readonly T[],
  pins: ReadonlyMap<string, boolean>,
): T[] {
  return projects.map((project) => withPendingPin(project, pins));
}

/** The projects whose key or title contains the query, ignoring case; an empty query keeps all. */
export function filterProjects<T extends Pick<EngineNode, 'id' | 'title'>>(
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
