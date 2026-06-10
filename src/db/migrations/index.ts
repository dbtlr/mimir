import type { Migration } from "kysely";
import { migration as init0001 } from "./0001_init";
import { migration as artifactSeq0002 } from "./0002_artifact_seq";

/**
 * The static migration set, keyed by name. Keys sort lexicographically and
 * that order is the apply order, so names are zero-padded + ordinal
 * (`0001_init`, `0002_...`). Bundled statically (not `FileMigrationProvider`)
 * so the single binary carries its migrations with no filesystem lookup.
 */
export const migrations: Record<string, Migration> = {
  "0001_init": init0001,
  "0002_artifact_seq": artifactSeq0002,
};
