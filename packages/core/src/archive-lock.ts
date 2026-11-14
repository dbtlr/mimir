import { conflict, projectNotFound } from './errors';
import type { Project } from './model';

/**
 * The write-lock of a project-anchored record (ADR 0015): a seed or a delivery
 * whose own board is archived refuses every mutation, with the vocabulary of
 * the node write-lock (`mutations/common.ts#assertProjectActive`). An absent
 * board refuses too, so a write never reaches a board every read treats as
 * unknown. Asserted before any store write.
 */
export function assertBoardActive(
  project: Pick<Project, 'archived_at'> | undefined,
  key: string,
): void {
  if (project === undefined) {
    throw projectNotFound(key);
  }
  if (project.archived_at !== null) {
    throw conflict(
      `project ${key} is archived — no changes are allowed`,
      `unarchive it first: mimir unarchive ${key}`,
    );
  }
}
