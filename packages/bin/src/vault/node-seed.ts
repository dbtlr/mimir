import { validation } from '../core/errors';
import { renderHistoryBody, renderNodeBody } from '../core/history-codec';
import { renderId } from '../core/ids';
import type { Node, Project } from '../core/model';
import type { WorkingSet } from '../core/store';
import { nodeFrontmatter, projectFrontmatter } from '../core/vault-frontmatter';
import type { NornClient } from '../norn/client';

// The frontmatter mappers moved to core/ (MMR-153) so the node write path can
// share them without a norn→vault cycle; re-exported here for the seed's callers.
export { nodeFrontmatter, projectFrontmatter } from '../core/vault-frontmatter';

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

/**
 * One document to write: its vault path, frontmatter record, and body. The
 * body carries the `## History` section every mutation appends under (MMR-153):
 * a seeded doc is otherwise un-mutable over Norn, since `append_to_section`
 * refuses a missing heading. Frontmatter stays the sole read surface in Phase
 * 2b — the body is invisible to `loadWorkingSetOverNorn`.
 */
export type SeedDoc = { path: string; frontmatter: Record<string, unknown>; body: string };

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

/**
 * The body for each document — injected so the traversal is shared. The 2b seed
 * uses {@link EMPTY_BODIES} (empty `## History`/`## Annotations` anchors); the
 * authoritative migration (MMR-155) passes builders that reconstruct the
 * sections from the transition/annotation rows.
 */
export type NodeBodies = {
  node: (node: Node) => string;
  project: (project: Project) => string;
};

/** The 2b seed's bodies: the append anchors only, no records. */
export const EMPTY_BODIES: NodeBodies = {
  node: (node) => renderNodeBody(node.description),
  project: () => renderHistoryBody(),
};

/**
 * Project the whole working set into vault documents — the pure SQLite→vault
 * traversal shared by the 2b seed and the authoritative migration. Each doc gets
 * its canonical stem path, frontmatter through the shared mappers, and a body
 * from `bodies`. No I/O: the write is the caller's, and projects lead nodes so a
 * relation target is already placed when its dependent is written.
 */
export function buildSeedDocs(
  ws: WorkingSet,
  bodies: NodeBodies = EMPTY_BODIES,
): { projects: SeedDoc[]; nodes: SeedDoc[] } {
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

  const projects: SeedDoc[] = ws.projects.map((project) => ({
    body: bodies.project(project),
    frontmatter: projectFrontmatter(project, ws.projectTags.get(project.id) ?? []),
    path: `${project.key}/${project.key}.md`,
  }));
  const nodes: SeedDoc[] = [];
  for (const node of ws.nodes) {
    const key = keyByProject.get(node.project_id);
    const stem = stemById.get(node.id);
    if (key === undefined || stem === undefined) {
      continue; // orphaned node (unknown project) — cannot place it
    }
    const parentStem = node.parent_id === null ? null : (stemById.get(node.parent_id) ?? null);
    const dependsOn = (prereqStems.get(node.id) ?? []).toSorted();
    const tags = ws.nodeTags.get(node.id) ?? [];
    nodes.push({
      body: bodies.node(node),
      frontmatter: nodeFrontmatter(node, { dependsOn, parentStem, tags }),
      path: `${key}/${stem}.md`,
    });
  }
  return { nodes, projects };
}

/**
 * Write the whole working set into a fresh vault through the injected `write`
 * (the 2b seed, frontmatter-only bodies). The authoritative migration reuses
 * {@link buildSeedDocs} directly with reconstructing bodies + its own write.
 */
export async function seedNodes(ws: WorkingSet, write: SeedWrite): Promise<SeedReport> {
  const { projects, nodes } = buildSeedDocs(ws);
  const report: SeedReport = { created: 0, nodes: 0, projects: 0 };
  for (const doc of projects) {
    report[await write(doc)] += 1;
    report.projects += 1;
  }
  for (const doc of nodes) {
    report[await write(doc)] += 1;
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
  return async ({ body, frontmatter, path }) => {
    try {
      await client.newDoc({
        body,
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
