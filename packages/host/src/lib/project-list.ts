import type { ReviewReport } from '../api/view-queries';

/*
 * The Projects list (ADR 0013, MMR-790 refinement): the order of its rows and
 * the words they and the count line say. It reads the review report's
 * projects, the active projects with their counts, so the list, Home, and the
 * sidebar never disagree.
 */

/** An active project as the review report counts it. */
export type ListedProject = ReviewReport['projects'][number];

const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * The list's order: the projects that need you most first, then the most live
 * work, then by name, ignoring case. Pins play no part (MMR-790, Q3).
 */
export function projectsInListOrder(projects: readonly ListedProject[]): ListedProject[] {
  return projects.toSorted(
    (a, b) =>
      b.needsYou - a.needsYou ||
      b.live - a.live ||
      byName.compare(a.name, b.name) ||
      a.key.localeCompare(b.key),
  );
}

/** The archived projects' order: by title, as the active ones are by name. */
export function archivedInListOrder<T extends { title: string }>(projects: readonly T[]): T[] {
  return projects.toSorted((a, b) => byName.compare(a.title, b.title));
}

/** "11 projects", "1 project", or "No projects" when none is active. */
export function projectCountLine(active: number): string {
  if (active === 0) {
    return 'No projects';
  }
  return `${active.toLocaleString('en-US')} ${active === 1 ? 'project' : 'projects'}`;
}

/**
 * A phone row's one count: how many need you, as the attention pill, while
 * any do; otherwise how much is live, in words.
 */
export function projectPhoneCount(
  project: ListedProject,
): { kind: 'attention'; text: string } | { kind: 'words'; text: string } {
  if (project.needsYou > 0) {
    const verb = project.needsYou === 1 ? 'needs' : 'need';
    return { kind: 'attention', text: `${project.needsYou.toLocaleString('en-US')} ${verb} you` };
  }
  return {
    kind: 'words',
    text: project.live > 0 ? `${project.live.toLocaleString('en-US')} live` : 'Nothing live',
  };
}

/** A project with nothing live and nothing waiting on you: its name drops to ink-dim. */
export function projectSetBack(project: ListedProject): boolean {
  return project.needsYou === 0 && project.live === 0;
}
