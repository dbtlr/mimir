import type { ProjectPlace } from './container-list';
import { nodeIdOf } from './record-url';

/*
 * What the sidebar and the switcher read off the route (ADR 0013, MMR-492 and
 * MMR-730 refinements): the sidebar's context, where a project page sits in
 * its project, and which of the project's sections a page belongs to.
 */

/** A project's sections, the routes the switcher keeps when it changes project. */
export type SidebarSection = 'work' | 'tasks' | 'seeds' | 'artifacts';

/**
 * What the sidebar frames (MMR-505): a project, on its own `/p/KEY/…` pages,
 * Settings on `/settings`, its pages, and `/pair` (MMR-733), or All projects
 * everywhere else (`/`, `/doctor`). The remembered project does
 * not set it; that only steers the bare `/tasks`, `/seeds`, `/artifacts`
 * redirects.
 */
export type SidebarContext =
  | { kind: 'all' }
  | { kind: 'project'; key: string }
  | { kind: 'settings' };

const PROJECT_PATH = /^\/p\/([^/]+)(?:\/([^/]+))?\/?$/;
const SEED_SUFFIX = /^s\d+$/;
const ARTIFACT_SUFFIX = /^a\d+$/;

/** The key and trailing segment of a `/p/KEY[/segment]` path, or undefined off a project. */
function projectSegments(pathname: string): { key: string; segment?: string } | undefined {
  const match = PROJECT_PATH.exec(pathname);
  const key = match?.[1];
  if (key === undefined) {
    return undefined;
  }
  const segment = match?.[2];
  return segment === undefined ? { key } : { key, segment };
}

/**
 * The section a page belongs to, or undefined off a project (`/`, `/doctor`).
 * A seed's or artifact's page belongs to its browser; a node's page reads as
 * Work.
 */
export function sectionOfPath(pathname: string): SidebarSection | undefined {
  const segments = projectSegments(pathname);
  if (segments === undefined) {
    return undefined;
  }
  const { segment } = segments;
  switch (segment) {
    case undefined: {
      return 'work';
    }
    case 'tasks':
    case 'seeds':
    case 'artifacts': {
      return segment;
    }
    default: {
      if (SEED_SUFFIX.test(segment)) {
        return 'seeds';
      }
      if (ARTIFACT_SUFFIX.test(segment)) {
        return 'artifacts';
      }
      return 'work';
    }
  }
}

/** Is this a section's own route (`/p/MMR`, `/p/MMR/tasks`), rather than a record inside it? */
export function isSectionPage(pathname: string): boolean {
  const segment = projectSegments(pathname)?.segment;
  return (
    segment === undefined || segment === 'tasks' || segment === 'seeds' || segment === 'artifacts'
  );
}

/**
 * Where a project page sits (MMR-730): the project's own page (`/p/MMR`,
 * whatever its tab), a node's page (`/p/MMR/417`), or a page the project holds
 * that names no node (its lists, a seed, an artifact, a delivery). Undefined
 * off a project.
 */
export function projectPlaceOf(pathname: string): ProjectPlace | undefined {
  const segments = projectSegments(pathname);
  if (segments === undefined) {
    return undefined;
  }
  if (segments.segment === undefined) {
    return { kind: 'project' };
  }
  const id = nodeIdOf(segments.key, segments.segment);
  return id === undefined ? { kind: 'held' } : { id, kind: 'node' };
}

/** `/pair` approves a pairing request, so it belongs to Settings' Devices. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/') || pathname === '/pair';
}

/** The sidebar's context for a page: its project on a project page, Settings on its pages, else All projects. */
export function sidebarContextOf(pathname: string): SidebarContext {
  if (isSettingsPath(pathname)) {
    return { kind: 'settings' };
  }
  const key = projectSegments(pathname)?.key;
  return key === undefined ? { kind: 'all' } : { key, kind: 'project' };
}
