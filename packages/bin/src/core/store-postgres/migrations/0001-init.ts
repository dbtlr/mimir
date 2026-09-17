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
 * The initial Postgres schema (ADR 0030). Written as literal DDL rather than
 * through Kysely's schema builder: a migration is a historical fact, and it
 * must keep producing the same tables after the `DB` types above it move on.
 *
 * Every closed vocabulary is `CHECK`ed from the `@mimir/contract` enum arrays,
 * so a new lifecycle word is one edit away from a schema that admits it — and,
 * until the migration that widens the constraint runs, an older binary's value
 * set is enforced by the database rather than by hope.
 */

/** A closed vocabulary as a SQL `IN (...)` list. The values are compile-time
 * literals from the contract, never caller input, but they are quoted properly
 * regardless — a migration is the last place to invent a quoting rule. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');
}

export const statements: readonly string[] = [
  `CREATE TABLE schema_version (
     version    integer PRIMARY KEY,
     applied_at text NOT NULL
   )`,
  `CREATE TABLE project (
     key               text PRIMARY KEY CHECK (key ~ '^[A-Z]{2,4}$'),
     name              text NOT NULL,
     description       text,
     archived_at       text,
     last_seq          integer NOT NULL DEFAULT 0,
     last_artifact_seq integer NOT NULL DEFAULT 0,
     last_seed_seq     integer NOT NULL DEFAULT 0,
     next_present      boolean NOT NULL DEFAULT false,
     next_text         text,
     created_at        text NOT NULL,
     updated_at        text NOT NULL
   )`,
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
     open_ended   boolean,
     next_present boolean NOT NULL DEFAULT false,
     next_text    text,
     created_at   text NOT NULL,
     updated_at   text NOT NULL,
     UNIQUE (project_key, seq)
   )`,
  `CREATE INDEX idx_node_parent ON node(parent_id)`,
  `CREATE INDEX idx_node_project ON node(project_key)`,
  `CREATE TABLE dependency (
     node_id            text NOT NULL REFERENCES node(id),
     depends_on_node_id text NOT NULL REFERENCES node(id),
     PRIMARY KEY (node_id, depends_on_node_id),
     CHECK (node_id <> depends_on_node_id)
   )`,
  `CREATE TABLE annotation (
     id         bigserial PRIMARY KEY,
     node_id    text NOT NULL REFERENCES node(id),
     content    text NOT NULL,
     created_at text NOT NULL
   )`,
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
   )`,
  `CREATE TABLE artifact_link (
     artifact_id text NOT NULL REFERENCES artifact(id),
     node_id     text NOT NULL REFERENCES node(id),
     PRIMARY KEY (artifact_id, node_id)
   )`,
  `CREATE INDEX idx_artifact_link_node ON artifact_link(node_id)`,
  `CREATE TABLE tag (
     entity_type text NOT NULL CHECK (entity_type IN (${inList(TAG_ENTITY_TYPE_VALUES)})),
     entity_id   text NOT NULL,
     tag         text NOT NULL,
     PRIMARY KEY (entity_type, entity_id, tag)
   )`,
  `CREATE TABLE transition_log (
     id          bigserial PRIMARY KEY,
     node_id     text REFERENCES node(id),
     project_key text REFERENCES project(key),
     kind        text NOT NULL CHECK (kind IN (${inList(TRANSITION_KIND_VALUES)})),
     from_value  text,
     to_value    text,
     reason      text,
     handles     jsonb,
     at          text NOT NULL,
     CHECK ((node_id IS NULL) <> (project_key IS NULL))
   )`,
  `CREATE INDEX idx_transition_node ON transition_log(node_id, id)`,
  `CREATE INDEX idx_transition_at ON transition_log(at, id)`,
  `CREATE TABLE seed (
     id          text PRIMARY KEY,
     project_key text NOT NULL REFERENCES project(key),
     seq         integer NOT NULL,
     title       text NOT NULL,
     kind        text NOT NULL CHECK (kind IN (${inList(SEED_KIND_VALUES)})),
     lifecycle   text NOT NULL CHECK (lifecycle IN (${inList(SEED_LIFECYCLE_VALUES)})),
     requester   text,
     description text,
     spawned     text[] NOT NULL DEFAULT '{}',
     created_at  text NOT NULL,
     updated_at  text NOT NULL,
     UNIQUE (project_key, seq)
   )`,
  `CREATE TABLE seed_history (
     id         bigserial PRIMARY KEY,
     seed_id    text NOT NULL REFERENCES seed(id),
     kind       text NOT NULL,
     from_value text,
     to_value   text,
     reason     text,
     at         text NOT NULL
   )`,
  `CREATE INDEX idx_seed_history_seed ON seed_history(seed_id, id)`,
  `CREATE TABLE scratchpad (
     id          text PRIMARY KEY,
     project_key text NOT NULL REFERENCES project(key),
     title       text NOT NULL,
     anchors     text[] NOT NULL DEFAULT '{}',
     journal     jsonb NOT NULL,
     agenda      jsonb NOT NULL,
     freezing_at text,
     created_at  text NOT NULL,
     updated_at  text NOT NULL
   )`,
];
