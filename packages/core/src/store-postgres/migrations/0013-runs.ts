/**
 * Migration `0013_runs` (MMR-630) — the host's agent-run records (ADR 0041).
 * Host transport data like `host_secrets`: it never enters the work-state
 * transfer document. The partial unique index makes "one run at a time" the
 * insert itself, and `project`/`task` carry no foreign key because a run
 * outlives the deletion or replacement of its task (a fresh import, say), which
 * a foreign key would block or cascade.
 */
export const statements = [
  `CREATE TABLE runs (
    id text PRIMARY KEY,
    project text NOT NULL,
    task text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('groom')),
    trigger text NOT NULL CHECK (trigger IN ('console', 'schedule')),
    state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
    runner text NOT NULL,
    heartbeat_at text NOT NULL,
    model text NOT NULL,
    reserved_tokens bigint NOT NULL CHECK (reserved_tokens >= 0),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost_estimate_usd double precision,
    usage_settled boolean NOT NULL DEFAULT false,
    started_at text NOT NULL,
    ended_at text,
    outcome text
  )`,
  `CREATE UNIQUE INDEX runs_one_running ON runs (state) WHERE state = 'running'`,
] as const;
