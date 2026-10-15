/**
 * Migration `0005_project_pinned` (MMR-493) — adds the `pinned` flag to
 * `project`: the operator's "keep this one at hand" mark, which the console's
 * project switcher lists first. It lives in the store so it follows the one
 * operator across devices.
 *
 * Every existing project reads unpinned (`false`).
 */
export const statements: readonly string[] = [
  `ALTER TABLE project ADD COLUMN pinned boolean NOT NULL DEFAULT false`,
];
