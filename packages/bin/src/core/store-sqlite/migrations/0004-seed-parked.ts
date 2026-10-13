/**
 * Migration `0004_seed_parked` (MMR-473) — widens the `seed.lifecycle` check to
 * admit `parked`, the deliberate "later" for an untriaged seed. The vocabulary is
 * written as frozen literals, not read from the contract: a migration is a
 * historical fact, so a later change to the live enum can never alter what this
 * one means.
 *
 * SQLite cannot alter a `CHECK`, so the seed table is rebuilt. Its history table
 * references it, so both are rebuilt as `_next` copies (keeping every row and
 * every history id), the originals are dropped child-first so no foreign key is
 * ever left dangling, and the copies are renamed into place. The rename rewrites
 * the history's reference from `seed_next` to `seed`.
 */
export const statements: readonly string[] = [
  `CREATE TABLE seed_next (
     id          text PRIMARY KEY,
     project_key text NOT NULL REFERENCES project(key),
     seq         integer NOT NULL,
     title       text NOT NULL,
     kind        text NOT NULL CHECK (kind IN ('idea', 'bug', 'feature')),
     lifecycle   text NOT NULL
                 CHECK (lifecycle IN ('new', 'parked', 'promoted', 'resolved', 'rejected')),
     requester   text,
     description text,
     spawned     text NOT NULL DEFAULT '[]',
     created_at  text NOT NULL,
     updated_at  text NOT NULL,
     UNIQUE (project_key, seq)
   ) STRICT`,
  `INSERT INTO seed_next
     (id, project_key, seq, title, kind, lifecycle, requester, description, spawned,
      created_at, updated_at)
   SELECT id, project_key, seq, title, kind, lifecycle, requester, description, spawned,
          created_at, updated_at
   FROM seed`,
  `CREATE TABLE seed_history_next (
     id         integer PRIMARY KEY AUTOINCREMENT,
     seed_id    text NOT NULL REFERENCES seed_next(id),
     kind       text NOT NULL CHECK (kind IN ('lifecycle', 'hold', 'dependency', 'move', 'archive')),
     from_value text,
     to_value   text,
     reason     text,
     at         text NOT NULL
   ) STRICT`,
  `INSERT INTO seed_history_next (id, seed_id, kind, from_value, to_value, reason, at)
   SELECT id, seed_id, kind, from_value, to_value, reason, at FROM seed_history`,
  `DROP TABLE seed_history`,
  `DROP TABLE seed`,
  `ALTER TABLE seed_next RENAME TO seed`,
  `ALTER TABLE seed_history_next RENAME TO seed_history`,
  `CREATE INDEX idx_seed_history_seed ON seed_history(seed_id, id)`,
];
