import type { Migration } from 'kysely';

import { migration as init0001 } from './0001_init';
import { migration as artifactSeq0002 } from './0002_artifact_seq';
import { migration as artifactTitle0003 } from './0003_artifact_title';
import { migration as dropRepoPath0004 } from './0004_drop_repo_path';
import { migration as projectDescription0005 } from './0005_project_description';
import { migration as lifecycleUnderReview0006 } from './0006_lifecycle_under_review';

/**
 * The static migration set, keyed by name. Keys sort lexicographically and
 * that order is the apply order, so names are zero-padded + ordinal
 * (`0001_init`, `0002_...`). Bundled statically (not `FileMigrationProvider`)
 * so the single binary carries its migrations with no filesystem lookup.
 */
export const migrations: Record<string, Migration> = {
  '0001_init': init0001,
  '0002_artifact_seq': artifactSeq0002,
  '0003_artifact_title': artifactTitle0003,
  '0004_drop_repo_path': dropRepoPath0004,
  '0005_project_description': projectDescription0005,
  '0006_lifecycle_under_review': lifecycleUnderReview0006,
};
