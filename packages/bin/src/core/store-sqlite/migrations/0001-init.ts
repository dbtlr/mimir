import {
  HOLD_VALUES,
  LIFECYCLE_VALUES,
  NODE_TYPE_VALUES,
  PRIORITY_VALUES,
  SEED_KIND_VALUES,
  SEED_LIFECYCLE_VALUES,
  SIZE_VALUES,
  TAG_ENTITY_TYPE_VALUES,
  TRANSITION_KIND_VALUES,
} from '@mimir/contract';

/**
 * The initial SQLite schema (ADR 0032) — the same tables, keys, and checks as
 * the Postgres `0001_init`, in SQLite's terms. Literal DDL for the reason the
 * Postgres migration gives: a migration is a historical fact.
 *
 * Every table is `STRICT`, so a column holds only its declared type, as
 * Postgres enforces. Where Postgres has a type SQLite lacks, the column stores
 * an encoding the dialect's codecs own:
 *
 * - a boolean is an `integer` checked to 0 or 1;
 * - a `text[]` list and a `jsonb` document are JSON `text`;
 * - a `bigserial` is `integer PRIMARY KEY AUTOINCREMENT`, which never reuses an
 *   id, so a log's id order stays its append order.
 *
 * The project-key check is a `GLOB` with a length bound, because SQLite has no
 * built-in regular expression operator.
 */

/** A closed vocabulary as a SQL `IN (...)` list (see the Postgres migration). */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');
}

/** A 0/1 `integer` column standing in for a boolean. */
function bool(column: string): string {
  return `${column} IN (0, 1)`;
}

export const statements: readonly string[] = [
  `CREATE TABLE schema_version (
     version    integer PRIMARY KEY,
     applied_at text NOT NULL
   ) STRICT`,
  `CREATE TABLE project (
     key               text PRIMARY KEY
                         CHECK (length(key) BETWEEN 2 AND 4 AND key NOT GLOB '*[^A-Z]*'),
     name              text NOT NULL,
     description       text,
     archived_at       text,
     last_seq          integer NOT NULL DEFAULT 0,
     last_artifact_seq integer NOT NULL DEFAULT 0,
     last_seed_seq     integer NOT NULL DEFAULT 0,
     next_present      integer NOT NULL DEFAULT 0 CHECK (${bool('next_present')}),
     next_text         text,
     created_at        text NOT NULL,
     updated_at        text NOT NULL
   ) STRICT`,
  `CREATE TABLE node (
     id           text PRIMARY KEY,
     project_key  text NOT NULL REFERENCES project(key),
     type         text NOT NULL CHECK (type IN (${inList(NODE_TYPE_VALUES)})),
     parent_id    text REFERENCES node(id) DEFERRABLE INITIALLY DEFERRED,
     seq          integer NOT NULL,
     title        text NOT NULL,
     description  text,
     summary      text,
     lifecycle    text CHECK (lifecycle IN (${inList(LIFECYCLE_VALUES)})),
     hold         text CHECK (hold IN (${inList(HOLD_VALUES)})),
     hold_reason  text,
     priority     text CHECK (priority IN (${inList(PRIORITY_VALUES)})),
     size         text CHECK (size IN (${inList(SIZE_VALUES)})),
     rank         integer,
     external_ref text,
     upstream     text,
     host         text,
     harness      text,
     session      text,
     branch       text,
     completed_at text,
     target       text,
     open_ended   integer CHECK (${bool('open_ended')}),
     next_present integer NOT NULL DEFAULT 0 CHECK (${bool('next_present')}),
     next_text    text,
     created_at   text NOT NULL,
     updated_at   text NOT NULL,
     UNIQUE (project_key, seq)
   ) STRICT`,
  `CREATE INDEX idx_node_parent ON node(parent_id)`,
  `CREATE INDEX idx_node_project ON node(project_key)`,
  `CREATE TABLE dependency (
     node_id            text NOT NULL REFERENCES node(id),
     depends_on_node_id text NOT NULL REFERENCES node(id),
     PRIMARY KEY (node_id, depends_on_node_id),
     CHECK (node_id <> depends_on_node_id)
   ) STRICT`,
  `CREATE TABLE annotation (
     id         integer PRIMARY KEY AUTOINCREMENT,
     node_id    text NOT NULL REFERENCES node(id),
     content    text NOT NULL,
     created_at text NOT NULL
   ) STRICT`,
  `CREATE INDEX idx_annotation_node ON annotation(node_id)`,
  `CREATE TABLE artifact (
     id             text PRIMARY KEY,
     project_key    text NOT NULL REFERENCES project(key),
     seq            integer NOT NULL,
     title          text NOT NULL,
     summary        text,
     content        text NOT NULL,
     source_scratch text,
     created_at     text NOT NULL,
     updated_at     text NOT NULL,
     UNIQUE (project_key, seq)
   ) STRICT`,
  `CREATE TABLE artifact_link (
     artifact_id text NOT NULL REFERENCES artifact(id),
     node_id     text NOT NULL REFERENCES node(id),
     PRIMARY KEY (artifact_id, node_id)
   ) STRICT`,
  `CREATE INDEX idx_artifact_link_node ON artifact_link(node_id)`,
  `CREATE TABLE tag (
     entity_type text NOT NULL CHECK (entity_type IN (${inList(TAG_ENTITY_TYPE_VALUES)})),
     entity_id   text NOT NULL,
     tag         text NOT NULL,
     PRIMARY KEY (entity_type, entity_id, tag)
   ) STRICT`,
  `CREATE TABLE transition_log (
     id          integer PRIMARY KEY AUTOINCREMENT,
     node_id     text REFERENCES node(id),
     project_key text REFERENCES project(key),
     kind        text NOT NULL CHECK (kind IN (${inList(TRANSITION_KIND_VALUES)})),
     from_value  text,
     to_value    text,
     reason      text,
     handles     text,
     at          text NOT NULL,
     CHECK ((node_id IS NULL) <> (project_key IS NULL))
   ) STRICT`,
  `CREATE INDEX idx_transition_node ON transition_log(node_id, id)`,
  `CREATE INDEX idx_transition_at ON transition_log(at, id)`,
  `CREATE INDEX idx_transition_project ON transition_log(project_key, id)`,
  `CREATE TABLE seed (
     id          text PRIMARY KEY,
     project_key text NOT NULL REFERENCES project(key),
     seq         integer NOT NULL,
     title       text NOT NULL,
     kind        text NOT NULL CHECK (kind IN (${inList(SEED_KIND_VALUES)})),
     lifecycle   text NOT NULL CHECK (lifecycle IN (${inList(SEED_LIFECYCLE_VALUES)})),
     requester   text,
     description text,
     spawned     text NOT NULL DEFAULT '[]',
     created_at  text NOT NULL,
     updated_at  text NOT NULL,
     UNIQUE (project_key, seq)
   ) STRICT`,
  `CREATE TABLE seed_history (
     id         integer PRIMARY KEY AUTOINCREMENT,
     seed_id    text NOT NULL REFERENCES seed(id),
     kind       text NOT NULL CHECK (kind IN (${inList(TRANSITION_KIND_VALUES)})),
     from_value text,
     to_value   text,
     reason     text,
     at         text NOT NULL
   ) STRICT`,
  `CREATE INDEX idx_seed_history_seed ON seed_history(seed_id, id)`,
  `CREATE TABLE scratchpad (
     id          text PRIMARY KEY,
     project_key text NOT NULL REFERENCES project(key),
     title       text NOT NULL,
     anchors     text NOT NULL DEFAULT '[]',
     journal     text NOT NULL,
     agenda      text NOT NULL,
     freezing_at text,
     created_at  text NOT NULL,
     updated_at  text NOT NULL
   ) STRICT`,
];
