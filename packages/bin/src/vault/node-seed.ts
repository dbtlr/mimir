import { validation } from '../core/errors';
import { renderId } from '../core/ids';
import type { Node, Project } from '../core/model';
import type { NodeTag, WorkingSet } from '../core/store';
import type { NornClient } from '../norn/client';

/**
 * Node seed (MMR-150, ADR 0016 Phase 2b) — a **throwaway, non-authoritative**
 * projection of the SQLite store into frontmatter-only vault files, so the
 * Phase 2b read backend (MMR-149) and its parity harness (MMR-151) can read the
 * same logical state through Norn. It is a test/dev helper, not a shipped
 * command: the authoritative, lossless SQLite→markdown migration (created_at /
 * `## History` reconstruction, exact id continuity) is Phase 3. SQLite stays the
 * source of truth here; the seed only writes into the vault.
 *
 * Frontmatter only — no `## History`, no `## Annotations` (those surfaces read
 * on `store.db` until Phase 3). The filename stem is the canonical id
 * (`KEY/KEY.md` for a project, `KEY/KEY-seq.md` for a node); `parent`/
 * `depends_on` are written as real wikilinks (Norn collapses brackets in field
 * matching). Layout mirrors the artifact seam (`core/artifacts/norn.ts`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FRONTMATTER FIELD CONTRACT (reconciled with MMR-149). The read backend owns
 * the vocabulary the schema rules validate and `loadWorkingSetOverNorn` reads
 * back; this seed emits exactly that: `created` for the creation timestamp
 * (matching the artifact precedent and the merged reader), `updated_at`, and the
 * model's snake_case names for the rest (`lifecycle`/`hold`/`priority`/…). The
 * mapping lives entirely in the two `*Frontmatter` functions below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** One document to write: its vault path and the frontmatter record. */
export type SeedDoc = { path: string; frontmatter: Record<string, unknown> };

/**
 * The injected write. The seed targets a FRESH vault (the harness converges a
 * new one per run), so every write creates a document; a pre-existing path is
 * out of contract and fails loud rather than merging (which would leave fields
 * that cleared in SQLite stale — a false parity mismatch) or clobbering a doc
 * whose identity was never checked. Node convergence over a mutated vault would
 * need field-level removal Norn's `set` doesn't offer; the authoritative,
 * lossless migration is Phase 3.
 */
export type SeedWrite = (doc: SeedDoc) => Promise<SeedOutcome>;

export type SeedOutcome = 'created';

export type SeedReport = {
  projects: number;
  nodes: number;
  created: number;
};

const wikilink = (stem: string): string => `[[${stem}]]`;

/** Set `key` only when `value` is a non-null scalar — mirrors the omit-empty artifact shape. */
function put(fm: Record<string, unknown>, key: string, value: string | number | null): void {
  if (value !== null) {
    fm[key] = value;
  }
}

/** Project → frontmatter record. `key`/`name`/`type` always; the rest omit-when-empty. */
export function projectFrontmatter(
  project: Project,
  tags: readonly NodeTag[],
): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    created: project.created_at,
    key: project.key,
    name: project.name,
    type: 'project',
    updated_at: project.updated_at,
  };
  put(fm, 'description', project.description);
  put(fm, 'archived_at', project.archived_at);
  if (tags.length > 0) {
    fm.tags = tags.map((t) => t.tag);
  }
  return fm;
  // last_seq / last_artifact_seq are SQLite allocation counters, deliberately
  // dropped: Phase 2b derives seq as max(seq)+1 over the vault (ADR 0016 fork #1).
}

/** Node → frontmatter record. Relations arrive resolved to stems by the caller. */
export function nodeFrontmatter(
  node: Node,
  rel: { parentStem: string | null; dependsOn: readonly string[]; tags: readonly NodeTag[] },
): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    created: node.created_at,
    title: node.title,
    type: node.type,
    updated_at: node.updated_at,
  };
  put(fm, 'description', node.description);
  if (rel.parentStem !== null) {
    fm.parent = wikilink(rel.parentStem);
  }
  if (rel.dependsOn.length > 0) {
    fm.depends_on = rel.dependsOn.map(wikilink);
  }
  if (rel.tags.length > 0) {
    fm.tags = rel.tags.map((t) => t.tag);
  }
  put(fm, 'lifecycle', node.lifecycle);
  // `hold: 'none'` is the neutral default — omit it (and null) so a task carries
  // a hold only when actually held; the reader defaults absent → 'none'.
  put(fm, 'hold', node.hold === 'none' ? null : node.hold);
  put(fm, 'hold_reason', node.hold_reason);
  put(fm, 'priority', node.priority);
  put(fm, 'size', node.size);
  put(fm, 'rank', node.rank);
  put(fm, 'external_ref', node.external_ref);
  put(fm, 'completed_at', node.completed_at);
  put(fm, 'target', node.target);
  return fm;
}

/**
 * Project the whole working set into vault docs through the injected `write`.
 * Pure orchestration — no Norn dependency — so the mapping and traversal test
 * without a live vault (the `migrateArtifacts` shape). Projects first, then
 * nodes, so a node's `parent`/`depends_on` targets are already on disk.
 */
export async function seedNodes(ws: WorkingSet, write: SeedWrite): Promise<SeedReport> {
  const keyByProject = new Map(ws.projects.map((p) => [p.id, p.key] as const));
  // Every node's canonical stem, resolved through its project's key — used for
  // its own path and for any relation (parent, cross-project depends_on) to it.
  const stemById = new Map<number, string>();
  for (const node of ws.nodes) {
    const key = keyByProject.get(node.project_id);
    if (key !== undefined) {
      stemById.set(node.id, renderId({ key, seq: node.seq }));
    }
  }
  const prereqStems = new Map<number, string[]>();
  for (const edge of ws.edges) {
    const stem = stemById.get(edge.depends_on_node_id);
    if (stem === undefined) {
      continue; // a dangling prerequisite id — nothing to link
    }
    const list = prereqStems.get(edge.node_id);
    if (list === undefined) {
      prereqStems.set(edge.node_id, [stem]);
    } else {
      list.push(stem);
    }
  }

  const report: SeedReport = { created: 0, nodes: 0, projects: 0 };
  const tally = (outcome: SeedOutcome): void => {
    report[outcome] += 1;
  };

  for (const project of ws.projects) {
    const tags = ws.projectTags.get(project.id) ?? [];
    tally(
      await write({
        frontmatter: projectFrontmatter(project, tags),
        path: `${project.key}/${project.key}.md`,
      }),
    );
    report.projects += 1;
  }
  for (const node of ws.nodes) {
    const key = keyByProject.get(node.project_id);
    const stem = stemById.get(node.id);
    if (key === undefined || stem === undefined) {
      continue; // orphaned node (unknown project) — cannot place it
    }
    const parentStem = node.parent_id === null ? null : (stemById.get(node.parent_id) ?? null);
    const dependsOn = (prereqStems.get(node.id) ?? []).toSorted();
    const tags = ws.nodeTags.get(node.id) ?? [];
    tally(
      await write({
        frontmatter: nodeFrontmatter(node, { dependsOn, parentStem, tags }),
        path: `${key}/${stem}.md`,
      }),
    );
    report.nodes += 1;
  }
  return report;
}

/** `field=<json>` entries for `vault.new` — the newDoc shape of a frontmatter record. */
function toFieldJson(frontmatter: Record<string, unknown>): string[] {
  return Object.entries(frontmatter).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
}

function isPathCollision(error: unknown): boolean {
  return error instanceof Error && /already exists/i.test(error.message);
}

/**
 * The live-Norn write: upsert one seed doc. `vault.new` is create-exclusive, so
 * a fresh path is `created`; a collision means a prior seed wrote this node, and
 * because nodes are *mutable* (unlike append-only artifacts) the seed overwrites
 * to the current state via `vault.set` → `updated`. Present fields are set;
 * fields that became absent since a prior seed are not pruned (a throwaway seed
 * over a harness's fresh vault — full convergence isn't a goal). No body: nodes
 * are frontmatter-only in Phase 2b.
 */
export function nornSeedWrite(client: NornClient): SeedWrite {
  return async ({ frontmatter, path }) => {
    try {
      await client.newDoc({
        confirm: true,
        field_json: toFieldJson(frontmatter),
        parents: true,
        path,
      });
      return 'created';
    } catch (error) {
      if (isPathCollision(error)) {
        throw validation(
          `vault already has a document at ${path}`,
          'the node seed targets a fresh vault — re-converge a new one rather than re-seeding a populated one',
        );
      }
      throw error;
    }
  };
}
