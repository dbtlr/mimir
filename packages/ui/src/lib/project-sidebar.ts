import type { WireNode } from '../api/types';
import { nodeIdOf } from './record-url';

/*
 * What the project sidebar reads off the route (ADR 0013, MMR-492 refinement):
 * which of its sections the page belongs to, and which node a record page opens.
 */

/** The sidebar's sections, in order. */
export type SidebarSection = 'work' | 'tasks' | 'seeds' | 'artifacts';

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
  recordType?: WireNode['type'],
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

/** The node id a record page's path opens (`/p/MMR/417` → `MMR-417`), or undefined. */
export function openRecordId(pathname: string): string | undefined {
  const segments = projectSegments(pathname);
  return segments?.segment === undefined ? undefined : nodeIdOf(segments.key, segments.segment);
}
