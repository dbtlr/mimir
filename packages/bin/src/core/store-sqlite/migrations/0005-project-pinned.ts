/**
 * Migration `0005_project_pinned` (MMR-493) — adds the `pinned` flag to
 * `project`: the operator's "keep this one at hand" mark, which the console's
 * project switcher lists first. It lives in the store so it follows the one
 * operator across devices.
 *
 * `ALTER TABLE ... ADD COLUMN` accepts `NOT NULL` with a constant default and a
 * `CHECK` on a STRICT table, so no rebuild is needed. A boolean is an `integer`
 * checked to 0 or 1, as `next_present` is; every existing project reads
 * unpinned (0).
 */
export const statements: readonly string[] = [
  `ALTER TABLE project ADD COLUMN pinned integer NOT NULL DEFAULT 0
     CHECK (pinned IN (0, 1))`,
];
