import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useEffect } from 'react';

import { projectsQuery } from '../api/queries';
import type { WireNode } from '../api/types';

/**
 * The current project (ADR 0013, MMR-492 refinement): the one in the URL, else
 * the last one visited on this device, else the first in the switcher's order.
 * The remembered key lives in localStorage like the theme pick, so it is
 * per device and never follows the operator elsewhere.
 */

const STORAGE_KEY = 'mimir-current-project';

/**
 * What the ordering reads off a project. `pinned` and `last_activity_at` are
 * optional until the project wire type carries them; a list without them keeps
 * its own order.
 */
type Orderable = Pick<WireNode, 'id' | 'archived_at'> & {
  pinned?: boolean | null;
  last_activity_at?: string | null;
};

const isActive = (p: Orderable) => p.archived_at == null;

const activityOf = (p: Orderable): number =>
  p.last_activity_at == null ? Number.NEGATIVE_INFINITY : Date.parse(p.last_activity_at);

/** Newest activity first; two projects with equal activity (or none) compare as a tie. */
function byActivityDesc(a: Orderable, b: Orderable): number {
  const [x, y] = [activityOf(a), activityOf(b)];
  if (x === y) {
    return 0;
  }
  return y > x ? 1 : -1;
}

/**
 * The switcher's order: pinned projects first, then by most recent activity,
 * newest first. Archived projects are left out. Ties — including a list with no
 * pin or activity data at all — keep the list's own order. This is the one
 * place the order is defined; the switcher reads it from here.
 */
export function orderProjects<T extends Orderable>(projects: readonly T[]): T[] {
  return projects
    .filter(isActive)
    .toSorted(
      (a, b) => Number(b.pinned === true) - Number(a.pinned === true) || byActivityDesc(a, b),
    );
}

/** The last project visited on this device, or undefined when none is stored. */
export function readRememberedProject(): string | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === null || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Record `key` as the last project visited. */
export function rememberProject(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // private mode / storage disabled — the project just isn't remembered
  }
}

/**
 * The current project's key. The URL's key wins outright. Otherwise the
 * remembered key, while it still names an active project (or while the list has
 * not loaded), else the first active project in switcher order, else undefined
 * when there are no projects.
 */
export function resolveCurrentProjectKey(input: {
  urlKey?: string;
  remembered?: string;
  projects?: readonly Orderable[];
}): string | undefined {
  const { urlKey, remembered, projects } = input;
  if (urlKey !== undefined) {
    return urlKey;
  }
  if (projects === undefined) {
    return remembered;
  }
  const ordered = orderProjects(projects);
  return ordered.find((p) => p.id === remembered)?.id ?? ordered[0]?.id;
}

/**
 * The current project's key for the page being rendered, or undefined while
 * there is nothing to name (no projects, or none yet loaded and none remembered).
 */
export function useCurrentProjectKey(): string | undefined {
  // Loose read — the key only exists on the /p/$key routes.
  const { key } = useParams({ strict: false });
  const projects = useQuery(projectsQuery);
  return resolveCurrentProjectKey({
    projects: projects.data?.items,
    remembered: readRememberedProject(),
    urlKey: key,
  });
}

/**
 * Remember the project a /p/$key page shows, once the project list confirms it
 * exists — a mistyped key never becomes the current project. Mounted once, by
 * the shell.
 */
export function useRememberCurrentProject(): void {
  const { key } = useParams({ strict: false });
  const projects = useQuery(projectsQuery);
  const known = projects.data?.items.find((p) => p.id === key?.toUpperCase());
  const id = known !== undefined && isActive(known) ? known.id : undefined;
  useEffect(() => {
    if (id !== undefined) {
      rememberProject(id);
    }
  }, [id]);
}
