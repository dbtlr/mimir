import type { SeedKind, SeedLifecycle } from '@mimir/contract';

/**
 * The seed storage seam (MMR-244) — a grooming-queue record filed against a
 * project that implies NO work, only triage. A seed is the artifact model's
 * sibling (ADR 0004 precedent): project-anchored, its own `KEY-sN` id grammar,
 * NOT a tree node. It lives at `KEY/seeds/KEY-sN.md`, sibling of `KEY/artifacts/`.
 *
 * Keyed by **external identity** (`key` + `seq`, the `KEY-sN` stem): no numeric
 * ids cross this boundary, exactly like the artifact seam — the Norn vault has
 * none (the file stem is the id, ADR 0016).
 *
 * The seam owns the lifecycle machine (`new → promoted | resolved | rejected`;
 * `promoted → resolved | rejected`) and the store-level mutation primitives
 * ({@link SeedStore.patch}/{@link SeedStore.transition}/{@link SeedStore.germinate}).
 * The verb surface (CLI/MCP/HTTP) rides on top in MMR-245; `requester`/`spawned`
 * are verb-owned relations, never patched directly.
 *
 * **Norn backend only.** The SQLite backend is a fenced rollback being retired
 * (MMR-234) and never grows a seed table; its arm throws (see `sqlite.ts`).
 */

/** One seed's metadata, backend-neutral. Description is BODY prose, never here. */
export type SeedRecord = {
  key: string;
  seq: number;
  title: string;
  kind: SeedKind;
  lifecycle: SeedLifecycle;
  /** Requester-side project key (null = self-filed at the target board). */
  requester: string | null;
  /** Work-node stems (`KEY-seq`) this seed germinated — verb-owned, append-only. */
  spawned: string[];
  created_at: string;
  updated_at: string;
};

export type SeedCreate = {
  /** The owning (target) project's key — existence/active already asserted by the verb. */
  key: string;
  title: string;
  kind: SeedKind;
  /** Prose description; lives in the `## Seed Description` body section. */
  description: string | null;
  /** Requester-side project key, or null to self-file at the target board. */
  requester: string | null;
};

/** The live-only patchable fields (ADR 0004 precedent: content-shaped edits). A
 * terminal seed (`resolved`/`rejected`) refuses every patch. */
export type SeedPatch = {
  title?: string;
  kind?: SeedKind;
  /** The `## Seed Description` prose; `null` clears it. */
  description?: string | null;
};

export type SeedStore = {
  /** Allocate the next `KEY-sN` seq and persist the seed; returns its identity. */
  create: (input: SeedCreate) => Promise<{ key: string; seq: number }>;
  /** One seed's record; the `## Seed Description` prose only when `content` is opted in. */
  load: (
    key: string,
    seq: number,
    opts?: { content?: boolean },
  ) => Promise<(SeedRecord & { description?: string | null }) | undefined>;
  /** A project's whole seed inventory, seq ascending. */
  listForProject: (key: string) => Promise<SeedRecord[]>;
  /** Edit a LIVE seed's title/kind/description; refuses when the seed is terminal
   * or absent — a terminal seed is frozen (the reason string carries the nuance). */
  patch: (key: string, seq: number, patch: SeedPatch) => Promise<void>;
  /** Move a seed along the lifecycle machine, recording the transition in
   * `## History` with the (required) reason. Refuses an illegal edge or an
   * absent seed. */
  transition: (key: string, seq: number, to: SeedLifecycle, reason: string) => Promise<void>;
  /** Germinate the seed for promote (MMR-245): from ONE load, apply ONE atomic
   * plan that appends the work-node stem (`KEY-seq`) to `spawned`, crosses
   * `new → promoted` on the first promote (with its `## History` record), and
   * stamps `updated_at` — so the seed can never reflect a spawned task without the
   * lifecycle move, nor vice versa. Idempotent: a re-run whose stem is already
   * linked AND whose seed is already promoted is a no-op (a retried promote cannot
   * double-record). Refuses a terminal (frozen) or absent seed. On a compare-and-set
   * refusal (a concurrent write moved the doc) it re-reads once and retries. */
  germinate: (key: string, seq: number, nodeStem: string) => Promise<void>;
};

/**
 * The seed lifecycle machine (MMR-244): the legal `from → to` edges. Both
 * terminals are reachable from both live states — "already fixed / already
 * exists" is a *resolution* straight from `new`, the reason string carrying the
 * nuance. The terminals (`resolved`/`rejected`) have no outgoing edges: a
 * terminal seed is frozen.
 */
export const SEED_TRANSITIONS: Readonly<Record<SeedLifecycle, readonly SeedLifecycle[]>> = {
  new: ['promoted', 'resolved', 'rejected'],
  promoted: ['resolved', 'rejected'],
  rejected: [],
  resolved: [],
};

/** Is `lifecycle` a terminal (frozen) state — no outgoing transitions, no patches? */
export function isTerminalSeed(lifecycle: SeedLifecycle): boolean {
  return SEED_TRANSITIONS[lifecycle].length === 0;
}

/** May a seed move `from → to` under the lifecycle machine? */
export function canTransitionSeed(from: SeedLifecycle, to: SeedLifecycle): boolean {
  return SEED_TRANSITIONS[from].includes(to);
}
