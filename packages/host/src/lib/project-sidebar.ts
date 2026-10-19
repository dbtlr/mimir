import type { EngineNode } from '@mimir/contract';

import { nodeIdOf } from './record-url';

/*
 * What the project sidebar reads off the route (ADR 0013, MMR-492 refinement):
 * which of its sections the page belongs to, and which node a record page opens.
 */

/** The sidebar's sections, in order. */
export type SidebarSection = 'work' | 'tasks' | 'seeds' | 'artifacts';

/**
 * What the sidebar frames (MMR-505): a project, on its own `/p/KEY/…` pages, or
 * All projects everywhere else (`/`, `/doctor`). The remembered project does
 * not set it; that only steers the bare `/tasks`, `/seeds`, `/artifacts`
 * redirects.
 */
export type SidebarContext = { kind: 'all' } | { kind: 'project'; key: string };

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
 * A seed's or artifact's page belongs to its browser, a task's page to Tasks,
 * and an initiative's or phase's to Work. `recordType` is the opened node's
 * type when the tree has loaded; until then a node page reads as Work.
 */
export function sectionOfPath(
  pathname: string,
  recordType?: EngineNode['type'],
): SidebarSection | undefined {
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
      return recordType === 'task' ? 'tasks' : 'work';
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

/** The node id a record page's path opens (`/p/MMR/417` → `MMR-417`), or undefined. */
export function openRecordId(pathname: string): string | undefined {
  const segments = projectSegments(pathname);
  return segments?.segment === undefined ? undefined : nodeIdOf(segments.key, segments.segment);
}

/** The sidebar's context for a page: its project on a project page, else All projects. */
export function sidebarContextOf(pathname: string): SidebarContext {
  const key = projectSegments(pathname)?.key;
  return key === undefined ? { kind: 'all' } : { key, kind: 'project' };
}
