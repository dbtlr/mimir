/**
 * Migration `0006_project_remote` (MMR-543) — adds the nullable `remote` column
 * to `project`: the normalized Git remote (`host/path`) a clone resolves to its
 * project by. Deliberately not unique (several projects may share a repository).
 * Every existing project reads without one (NULL).
 */
export const statements: readonly string[] = [`ALTER TABLE project ADD COLUMN remote text`];
