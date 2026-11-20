/**
 * The forward-only migration list (ADR 0030). Static and ordered: a binary
 * carries its migrations in its own code, so there is no filesystem scan, no
 * ordering by filename, and no way for two binaries to disagree about what
 * version N means.
 *
 * `version` is the schema version a migration LANDS the store on, so the last
 * entry's version is `SCHEMA_VERSION`. Append, never edit — a migration that
 * has run on any store is a historical fact.
 *
 * The list is shared; the DDL is not. Each dialect supplies every migration's
 * literal statements by name ({@link MigrationStatements}), so appending a
 * migration here without writing it for every dialect does not compile.
 */
export const MIGRATIONS = [
  { name: '0001_init', version: 1 },
  { name: '0002_grooming', version: 2 },
  { name: '0003_block_owner', version: 3 },
  { name: '0004_seed_parked', version: 4 },
  { name: '0005_project_pinned', version: 5 },
  { name: '0006_project_remote', version: 6 },
  { name: '0007_task_queued', version: 7 },
  { name: '0008_main_worker', version: 8 },
  { name: '0009_device_tokens', version: 9 },
  { name: '0010_pairing_requests', version: 10 },
  { name: '0011_terminal_hold', version: 11 },
  { name: '0012_host_secrets', version: 12 },
  { name: '0013_runs', version: 13 },
  { name: '0014_task_staged', version: 14 },
  { name: '0015_delivery', version: 15 },
  { name: '0016_delivery_membership', version: 16 },
  { name: '0017_decision', version: 17 },
  { name: '0018_checklist_item', version: 18 },
  { name: '0019_delivery_finding', version: 19 },
  { name: '0020_delivery_since_indexes', version: 20 },
  { name: '0021_delivery_follow_up', version: 21 },
  { name: '0022_decision_option_details', version: 22 },
  { name: '0023_push_subscriptions', version: 23 },
  { name: '0024_push_subscription_muted_kinds', version: 24 },
] as const;

export type Migration = (typeof MIGRATIONS)[number];

/** Every migration's literal DDL in one dialect, keyed by migration name. */
export type MigrationStatements = Readonly<Record<Migration['name'], readonly string[]>>;
