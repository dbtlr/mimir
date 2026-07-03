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
 * FRONTMATTER FIELD CONTRACT (PROVISIONAL — must reconcile with MMR-149).
 * The read backend (MMR-149) owns the vocabulary the schema rules validate and
 * `loadWorkingSet` reads back; this seed must emit exactly that. Built in
 * parallel with 149, so its final choice is unobserved here. This module picks
 * the model's own snake_case names (`created_at`/`updated_at`/`lifecycle`/…),
 * justified by the `model.ts` note that those names ARE the wire bare-field
 * names — a 1:1 frontmatter↔model mapping with the least reader-side work. The
 * one place this diverges from the *artifact* precedent is the timestamp key:
 * artifacts use `created` (design-note shorthand); nodes use `created_at`. If
 * 149 landed `created`/`lastActivity` instead, update ONLY the two mappers
 * below — nothing else in the seed depends on the names.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** One document to write: its vault path and the frontmatter record. */
export type SeedDoc = { path: string; frontmatter: Record<string, unknown> };

/** The injected write — `created` (fresh), `updated` (overwrote), `skipped` (no-op). */
export type SeedWrite = (doc: SeedDoc) => Promise<SeedOutcome>;

export type SeedOutcome = 'created' | 'updated' | 'skipped';

export type SeedReport = {
  projects: number;
  nodes: number;
  created: number;
  updated: number;
  skipped: number;
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
    created_at: project.created_at,
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
    created_at: node.created_at,
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

  const report: SeedReport = { created: 0, nodes: 0, projects: 0, skipped: 0, updated: 0 };
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
      if (!isPathCollision(error)) {
        throw error;
      }
      await client.set({ confirm: true, set: frontmatter, target: path });
      return 'updated';
    }
  };
}
