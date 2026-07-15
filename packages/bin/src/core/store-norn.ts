import { HOLD_VALUES, LIFECYCLE_VALUES, PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { Lifecycle, NodeType } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import type { NornClient, NornDocument } from '../norn/client';
import { collapse, linkStems, stemOf, stringList } from '../norn/decode';
import { invariant } from './errors';
import { parseId, parseSeedRef } from './ids';
import type { Dependency, Node, Project } from './model';
import type { NodeTag, WorkingSet } from './store';
import { presentProjectKeys, validate } from './validate';

/**
 * The Norn-vault node read path (MMR-149, ADR 0016 Phase 2b) — the
 * `Store.loadWorkingSet` backend. One bulk `vault.find` over the work-state
 * document types projects the whole store, then this assembles the
 * {@link WorkingSet} derivation runs over, deterministically for a given vault
 * state.
 *
 * Deliberately harness/test-constructed only in 2b — not wired into
 * `buildStore` or any backend flag. No pushdown: the query is a flat "give me
 * every node/project", and every predicate/rollup stays in Mimir's in-memory
 * derivation pass.
 *
 * Two representational choices, both by design (the vault is the system of
 * record, not a mirror of relational rows):
 * - **Stem-native identity.** Project keys and node stems pass through unchanged;
 *   physical paths stay only in the transaction snapshot as locators.
 * - **Tags are a plain set.** Vault `tags` frontmatter carries no per-tag note
 *   or timestamp (ADR 0005); {@link toTagRecords} synthesizes the timestamp.
 */

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * Narrow a frontmatter value to an enum member. Norn has no enum field_type, so
 * value legality can't be enforced at the vault layer — the reader is the guard.
 * An ABSENT field returns null (the caller applies its own default /
 * nullability); a PRESENT but out-of-vocabulary value throws, enforcing in
 * code the same enum invariant a column CHECK constraint would enforce in a
 * schema.
 */
function enumFieldStrict<T extends string>(
  value: unknown,
  values: readonly T[],
  stem: string,
  field: string,
): T | null {
  if (value === undefined) {
    return null;
  }
  const s = str(value);
  if (s !== null && isMember(s, values)) {
    return s;
  }
  throw invariant(
    `node ${stem} has an invalid ${field} value`,
    `${field} must be one of: ${values.join(', ')}`,
  );
}

/**
 * The non-throwing enum narrow for the OPTIONAL task fields (`priority`/`size`,
 * MMR-177): absent → null, a valid member → the value, and a PRESENT foreign
 * value → null (no throw). Field validity keeps a node with a foreign
 * priority/size (null is a truthful "unset"), so a surviving node can still carry
 * one — this reads it as null rather than crashing the never-throw read path. The
 * tiering decision (null-the-field vs drop-the-node) lives only in {@link validate};
 * this is the mechanical "don't crash" over the SAME vocabulary. NOT used for
 * `lifecycle`/`hold`, whose bad nodes the validator already drops — those stay on
 * {@link enumFieldStrict} as a seam backstop.
 */
function enumFieldOrNull<T extends string>(value: unknown, values: readonly T[]): T | null {
  const s = str(value);
  return s !== null && isMember(s, values) ? s : null;
}

/**
 * The non-throwing boolean narrow for the container-only OPTIONAL field
 * `open_ended` (MMR-204). Norn has no boolean field_type, so the field rides
 * undeclared and round-trips as the strings `'true'`/`'false'` (see
 * `vault-frontmatter.ts`); a hand-authored YAML boolean is accepted too. Absent
 * or any foreign value → null — the foreign-nulls-the-field tiering that mirrors
 * {@link enumFieldOrNull} (the validator owns the null-vs-drop decision).
 */
function boolFieldOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  const s = str(value);
  if (s === 'true') {
    return true;
  }
  return s === 'false' ? false : null;
}

/**
 * The non-throwing decode for a task's `upstream` seed pointer (MMR-244), mirroring
 * {@link validate}'s view WHERE THE READER CAN ACT LOCALLY: collapse the wikilink
 * form ({@link collapse}), then null unless the grammar is a `KEY-sN` seed id — the
 * grammar tier nulled here exactly as {@link enumFieldOrNull} nulls a foreign
 * priority/size. A DANGLING but well-formed ref (valid grammar, no such seed) is
 * NOT decided here: the hot read path loads no seeds, so it stays the collapsed
 * stem and the resolving read seam (MMR-245) resolves it; the validator/`mimir
 * doctor` surface the dangle. The tiering decision lives in {@link validate}; this
 * is the mechanical "collapse + grammar guard".
 */
function seedRefOrNull(value: unknown): string | null {
  const stem = collapse(value);
  return stem !== null && parseSeedRef(stem) !== null ? stem : null;
}

/** Ascending string compare without a nested ternary (deterministic tiebreaks). */
function cmpStr(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * Vault tags are a plain string set — no per-tag note or timestamp (ADR 0005).
 * Project each onto a {@link NodeTag} with the document's own `created` as a
 * uniform `created_at`, sorted by tag so the order is deterministic,
 * tiebreaking on `(created_at, tag)` (MMR-148).
 */
function toTagRecords(tags: readonly string[], created: string): NodeTag[] {
  return tags.toSorted(cmpStr).map((tag) => ({ created_at: created, tag }));
}

type ProjectDoc = { key: string; path: string; fm: Record<string, unknown> };
type NodeDoc = {
  stem: string;
  path: string;
  key: string;
  seq: number;
  type: NodeType;
  fm: Record<string, unknown>;
};

/** One project document's frontmatter → the backend-neutral {@link Project}. The
 * single project decode both the whole-vault snapshot and the lightweight
 * {@link loadProjectsOverNorn} share, so a project reads identically either way. */
function decodeProject(key: string, fm: Record<string, unknown>): Project {
  return {
    archived_at: str(fm.archived_at),
    created_at: str(fm.created) ?? '',
    description: str(fm.description),
    key,
    name: str(fm.name) ?? '',
    updated_at: str(fm.updated_at) ?? '',
  };
}

/**
 * One (already-validated) node document → the backend-neutral {@link Node}. The
 * single node decode the whole-vault snapshot and the project-scoped
 * {@link loadNodesForProjectsOverNorn} share (MMR-251), so a node reads identically
 * either way — the read seam's one truth. `parentId` is the resolved parent stem
 * (or null) the validator returned; every task-only field is null for a container.
 * The lifecycle throw is a seam backstop: field validity (MMR-177) already dropped a
 * task with a missing/foreign lifecycle, so a survivor always carries a valid one.
 */
function decodeNode(
  stem: string,
  key: string,
  seq: number,
  type: NodeType,
  fm: Record<string, unknown>,
  parentId: string | null,
): Node {
  const isTask = type === 'task';
  let lifecycle: Lifecycle | null = null;
  if (isTask) {
    lifecycle = enumFieldStrict(fm.lifecycle, LIFECYCLE_VALUES, stem, 'lifecycle');
    if (lifecycle === null) {
      throw invariant(
        `task ${stem} survived validation without a lifecycle`,
        'field validity (MMR-177) must drop a task with a missing or foreign lifecycle before the reader',
      );
    }
  }
  return {
    completed_at: isTask ? str(fm.completed_at) : null,
    created_at: str(fm.created) ?? '',
    // `description` is not frontmatter (MMR-162): the WorkingSet leaves it null; the
    // prose is read on demand from the `## Task Description` body section.
    description: null,
    external_ref: isTask ? str(fm.external_ref) : null,
    // A task always carries a hold (default 'none'); a non-task never does.
    hold: isTask ? (enumFieldStrict(fm.hold, HOLD_VALUES, stem, 'hold') ?? 'none') : null,
    hold_reason: isTask ? str(fm.hold_reason) : null,
    id: stem,
    lifecycle,
    // Container-only (MMR-204): a foreign value nulls the field like priority/size.
    open_ended: isTask ? null : boolFieldOrNull(fm.open_ended),
    parent_id: parentId,
    // priority/size are optional (MMR-177): a foreign value nulls the field.
    priority: isTask ? enumFieldOrNull(fm.priority, PRIORITY_VALUES) : null,
    project_id: key,
    rank: isTask ? num(fm.rank) : null,
    seq,
    size: isTask ? enumFieldOrNull(fm.size, SIZE_VALUES) : null,
    summary: str(fm.summary),
    target: type === 'phase' ? str(fm.target) : null,
    title: str(fm.title) ?? '',
    type,
    updated_at: str(fm.updated_at) ?? '',
    // The requester-side seed pointer (MMR-244), task-only like `external_ref`.
    upstream: isTask ? seedRefOrNull(fm.upstream) : null,
  };
}

/**
 * A load-time snapshot of the vault's work-state (MMR-153): the same
 * {@link WorkingSet} the read path derives over, plus adapter-only side maps
 * the *write* path needs and the reader discards — the raw frontmatter per
 * document (the `expected_old_value` CAS precondition set_frontmatter demands)
 * and the stem → actual path locator needed by path-addressed apply operations.
 */
export type NornSnapshot = {
  workingSet: WorkingSet;
  /** Canonical stem → every physical path withheld because the identity collides. */
  collidingPathsByStem: ReadonlyMap<string, readonly string[]>;
  /** Node stem → its raw frontmatter record (presence + CAS old-value source). */
  nodeFm: ReadonlyMap<string, Record<string, unknown>>;
  /** Project key → its raw frontmatter record. */
  projectFm: ReadonlyMap<string, Record<string, unknown>>;
  /** Canonical stem → the surviving document's actual vault-relative path. */
  pathByStem: ReadonlyMap<string, string>;
  /**
   * Node id → the `depends_on` refs the validator PRUNED on load — a dangling
   * edge (points at no surviving node) or a cycle-closing edge broken by the
   * acyclicity pass. The working set omits them, so a later `transact` that
   * rewrites `depends_on` would regenerate the field from survivors alone and
   * silently erase them from disk (MMR-186). The write path re-merges these so
   * the pruned ref survives the write and `mimir doctor` keeps surfacing the
   * corruption — repair stays the deliberate `doctor --fix` decision (MMR-183),
   * per ADR 0017 (the reader drops, doctor reports, the write path does neither).
   * Bare `KEY-seq` stems, as {@link nodeRelations} produces for a live edge.
   */
  prunedDependsOn: ReadonlyMap<string, readonly string[]>;
};

/** One node's raw relational refs — its stem, project `key`, and unresolved
 * parent + prerequisite stems. `key` is the parsed KEY-seq key, carried so no
 * consumer re-parses the stem (mirrors the loader's `rawNodes`).
 *
 * `type` and `raw` are the OPTIONAL field-validity inputs (MMR-177): the node's
 * type (field checks are task-only) and its raw enum frontmatter. Both are
 * omitted by referential-only callers (e.g. validate.test's `graphOf`), and
 * {@link validate} skips its field pass when `raw` is absent — so a caller that
 * cares only about referential rules is unaffected. */
export type NodeRefs = {
  stem: string;
  /** Actual vault-relative path, when loaded from Norn (doctor identity diagnostics). */
  path?: string;
  key: string;
  parent: string | null;
  dependsOn: string[];
  /** A task's `upstream` seed pointer, collapsed (MMR-244) — null when absent.
   * Optional so referential-only fixtures needn't set it; validated only when the
   * graph carries {@link VaultGraph.seeds}. */
  upstream?: string | null;
  type?: NodeType;
  raw?: {
    lifecycle: unknown;
    hold: unknown;
    priority: unknown;
    size: unknown;
    /** Container-only (MMR-204); optional so referential-only fixtures needn't set it. */
    open_ended?: unknown;
  };
};

/** One work-state doc's declared project membership: its logical identity paired
 * with the collapsed `project` frontmatter (`[[KEY]]` → `KEY`, aliased forms too —
 * MMR-190), or null when the field is absent/malformed. Projects use their `key`
 * frontmatter even when physically relocated; nodes and seeds use their parsed
 * stems. The exact path lets doctor repair that logical owner without guessing.
 * The referential passes ignore it. */
export type ProjectDeclaration = {
  stem: string;
  project: string | null;
  /** Exact physical source for unambiguous diagnostics and repair. */
  path?: string;
  /** The typed identity source; optional for referential-only fixtures. */
  kind?: VaultGraphSource['kind'];
};

/** One seed's raw referential inputs (MMR-244): its `KEY-sN` stem + project key,
 * the raw `kind`/`lifecycle` frontmatter ({@link validate} owns legality), the
 * collapsed `requester` project key (null when absent), and the collapsed
 * `spawned` work-node stems. The validator vets these for `mimir doctor`. */
export type SeedRefs = {
  stem: string;
  key: string;
  kind: unknown;
  lifecycle: unknown;
  requester: string | null;
  spawned: string[];
};

/**
 * The vault's relational graph, read raw and unresolved: the valid nodes' refs
 * plus the set of project `key`s present. Both `mimir doctor` referential checks
 * resolve against this one read.
 */
export type VaultGraphSource = {
  kind: 'node' | 'project' | 'seed';
  stem: string;
  path: string;
};

export type VaultGraph = {
  nodes: NodeRefs[];
  projectKeys: string[];
  /** Work-state identities paired with their physical paths for collision checks. */
  sources?: readonly VaultGraphSource[];
  /** The subset of `projectKeys` whose project is ARCHIVED (`archived_at` set).
   * Carried so the validator can give the seed `requester` check the reader's
   * ACTIVE-only visibility (an archived requester is nulled on read, MMR-245/B1d),
   * distinct from a truly unknown one — WITHOUT the node missing-project pass ever
   * dropping an archived project's nodes (they exist, just hidden). Optional: only
   * {@link readVaultGraph}/{@link vaultGraphFromDocs} populate it; referential-only
   * callers (test fixtures) omit it and every project reads as active. */
  archivedProjectKeys?: readonly string[];
  /** Every parsed doc's declared project membership (MMR-231). Optional because
   * the referential-only producers (the resolving loader's `validate` input, test
   * fixtures) don't need it; {@link readVaultGraph}/{@link vaultGraphFromDocs}
   * always populate it, off the same read the referential passes use. */
  declarations?: readonly ProjectDeclaration[];
  /** The vault's seeds (MMR-244), when the caller loaded them. Present (possibly
   * empty) enables the seed passes in {@link validate} — seed kind/lifecycle,
   * `requester`, `spawned`, and task `upstream` — and its absence skips them
   * entirely (the node-only resolving loader and the transitions feed pass none). */
  seeds?: readonly SeedRefs[];
};

/**
 * Derive a node's referential refs from its frontmatter — the single derivation
 * the resolving reader ({@link loadNornSnapshot}) and {@link readVaultGraph}
 * share. Both feed the same {@link validate} pass, so the reader's drops and
 * doctor's findings must resolve over a byte-identical graph; one helper is what
 * makes that "one truth" a fact rather than a comment (MMR-181).
 */
function nodeRefsOf(
  fm: Record<string, unknown>,
  key: string,
  stem: string,
  type: NodeType,
  path?: string,
): NodeRefs {
  return {
    dependsOn: linkStems(fm.depends_on),
    key,
    parent: collapse(fm.parent),
    ...(path === undefined ? {} : { path }),
    // Field-validity inputs (MMR-177): the raw enum frontmatter, vetted in
    // validate's pass 0. Carried verbatim (unknown) — validate owns legality.
    raw: {
      hold: fm.hold,
      lifecycle: fm.lifecycle,
      open_ended: fm.open_ended,
      priority: fm.priority,
      size: fm.size,
    },
    stem,
    type,
    // The `upstream` seed pointer (MMR-244), collapsed so an accidental wikilink
    // form still resolves; validated only when the graph carries `seeds`.
    upstream: collapse(fm.upstream),
  };
}

/**
 * Read the vault's relational graph WITHOUT resolving it (MMR-169, MMR-178). The
 * resolving loader ({@link loadNornSnapshot}) throws on the first dangling ref or
 * missing project, so it can never enumerate them — `mimir doctor` reads below it
 * here and reports every node whose parent/prerequisite points at an absent stem,
 * or whose owning project has no document.
 *
 * Partitions exactly as the loader does: `nodes` holds only the docs whose refs
 * the loader resolves — its `rawNodes` partition (a `task`/`phase`/`initiative`
 * with a valid `KEY-seq` stem) — and `projectKeys` holds the `key` of every
 * `type: project` doc that carries one (its `projectDocs` partition). A project
 * resolves no parent/depends_on and a non-`KEY-seq` stem is dropped, so surfacing
 * either's stray ref would flag a vault the loader loads fine.
 */
export async function readVaultGraph(client: NornClient): Promise<VaultGraph> {
  // Includes seeds (MMR-244) so the seed passes run: `mimir doctor` reports seed
  // kind/lifecycle, unknown `requester`, dangling `spawned`, and task `upstream`.
  return vaultGraphFromDocs(
    await client.find({ in: ['type:project,task,phase,initiative,seed'], no_limit: true }),
    { withSeeds: true },
  );
}

/**
 * The pure core of {@link readVaultGraph} over an already-fetched document set —
 * split out (MMR-189) so a caller that has already run the `find` (the
 * transitions feed) derives the same graph from its one snapshot rather than
 * issuing a second identical query. Partitions exactly as the resolving loader
 * does; see {@link readVaultGraph}.
 */
export function vaultGraphFromDocs(
  docs: NornDocument[],
  opts?: { withSeeds?: boolean },
): VaultGraph {
  const nodes: NodeRefs[] = [];
  const projectKeys: string[] = [];
  const archivedProjectKeys: string[] = [];
  const declarations: ProjectDeclaration[] = [];
  const sources: VaultGraphSource[] = [];
  // Only populated (and only made present on the graph) when the caller asked —
  // the node-only resolving loader and the transitions feed pass no seeds, so the
  // seed/upstream passes in `validate` stay off for them (MMR-244).
  const seeds: SeedRefs[] = [];
  const withSeeds = opts?.withSeeds === true;
  for (const doc of docs) {
    const fm = doc.frontmatter;
    if (fm === undefined) {
      continue;
    }
    const type = str(fm.type);
    const stem = stemOf(doc.path);
    if (type === 'project') {
      const key = str(fm.key);
      if (key !== null && key !== '') {
        projectKeys.push(key);
        sources.push({ kind: 'project', path: doc.path, stem: key });
        if (str(fm.archived_at) !== null) {
          archivedProjectKeys.push(key);
        }
      }
      // A project doc's `project` is self-referential (`[[KEY]]`); a divergence
      // means it points at a different project than its own stem (MMR-231).
      declarations.push({
        kind: 'project',
        path: doc.path,
        project: collapse(fm.project),
        stem: key ?? stem,
      });
      continue;
    }
    if (withSeeds && type === 'seed') {
      const seedRef = parseSeedRef(stem);
      if (seedRef !== null) {
        sources.push({ kind: 'seed', path: doc.path, stem });
        seeds.push({
          key: seedRef.key,
          kind: fm.kind,
          lifecycle: fm.lifecycle,
          requester: collapse(fm.requester),
          spawned: linkStems(fm.spawned),
          stem,
        });
        declarations.push({ kind: 'seed', path: doc.path, project: collapse(fm.project), stem });
      }
      continue;
    }
    const ref = parseId(stem);
    if ((type !== 'task' && type !== 'phase' && type !== 'initiative') || ref === null) {
      continue;
    }
    nodes.push(nodeRefsOf(fm, ref.key, stem, type, doc.path));
    sources.push({ kind: 'node', path: doc.path, stem });
    declarations.push({ kind: 'node', path: doc.path, project: collapse(fm.project), stem });
  }
  return {
    archivedProjectKeys,
    declarations,
    nodes,
    projectKeys,
    sources,
    ...(withSeeds ? { seeds } : {}),
  };
}

export async function loadWorkingSetOverNorn(client: NornClient): Promise<WorkingSet> {
  return (await loadNornSnapshot(client)).workingSet;
}

export async function loadNornSnapshot(client: NornClient): Promise<NornSnapshot> {
  const docs = await client.find({
    in: ['type:project,task,phase,initiative'],
    no_limit: true,
  });

  // Partition documents by type; a doc without frontmatter, without a `key`
  // (project), or with a non-`KEY-seq` stem (node) is malformed and dropped.
  const projectDocs: ProjectDoc[] = [];
  const rawNodes: NodeDoc[] = [];
  for (const doc of docs) {
    const fm = doc.frontmatter;
    if (fm === undefined) {
      continue;
    }
    const type = str(fm.type);
    if (type === 'project') {
      const key = str(fm.key);
      if (key !== null && key !== '') {
        projectDocs.push({ fm, key, path: doc.path });
      }
    } else if (type === 'task' || type === 'phase' || type === 'initiative') {
      const ref = parseId(stemOf(doc.path));
      if (ref !== null) {
        rawNodes.push({
          fm,
          key: ref.key,
          path: doc.path,
          seq: ref.seq,
          stem: stemOf(doc.path),
          type,
        });
      }
    }
  }

  // Referential tolerance (ADR 0017, MMR-181): route the raw relational graph
  // through the shared validator and build only over the valid subgraph it
  // returns. The validator drops nodes whose project is absent and parent/
  // depends_on edges that resolve to no surviving node, so the referential
  // resolution below can no longer throw on vault corruption — a single bad
  // record degrades the read to a valid closed subgraph instead of taking the
  // whole load down. Deriving the graph exactly as {@link readVaultGraph} does
  // (collapse + linkStems) keeps the reader's and doctor's validity one truth.
  // The validator now covers every referential corruption — missing projects,
  // dangling edges, and cycles (acyclicity, MMR-174, including self-dependencies)
  // — AND field validity (MMR-177): it drops a task whose lifecycle/hold is
  // missing or foreign and nulls a foreign priority/size, so the build below can no
  // longer throw on vault data. Every SURVIVING node has a usable lifecycle/hold;
  // a foreign priority/size is nulled by {@link enumFieldOrNull} (the node stays).
  const validated = validate({
    nodes: rawNodes.map((n) => nodeRefsOf(n.fm, n.key, n.stem, n.type, n.path)),
    projectKeys: projectDocs.map((p) => p.key),
    sources: [
      ...projectDocs.map((p) => ({ kind: 'project' as const, path: p.path, stem: p.key })),
      ...rawNodes.map((n) => ({ kind: 'node' as const, path: n.path, stem: n.stem })),
    ],
  });
  const validRefs = validated.nodes;
  const validByStem = new Map(validRefs.map((r) => [r.stem, r]));
  const validProjectKeys = new Set(validated.projectKeys);
  const survivingProjects = projectDocs.filter((project) => validProjectKeys.has(project.key));
  const collidingPathsByStem = new Map<string, readonly string[]>();
  for (const drop of validated.dropped) {
    if (drop.kind === 'identity' && !collidingPathsByStem.has(drop.stem)) {
      collidingPathsByStem.set(drop.stem, drop.paths);
    }
  }

  // Index the pruned `depends_on` refs by stem so the write path can re-merge
  // them (MMR-186). Both drop rules point away from a surviving edge — a
  // dangling ref (no target) or a cycle-closing edge the acyclicity pass cut —
  // and both are corruption doctor surfaces; a field rewrite must preserve
  // either rather than silently erasing it. `parent` drops are deliberately NOT
  // carried: `parent` is single-valued and only a `move_node` dirties it, so the
  // overwrite is the operator's explicit intent, recorded by the move's History.
  const prunedDependsOnByStem = new Map<string, string[]>();
  for (const drop of validated.dropped) {
    if (drop.rule === 'dangling-depends-on' || drop.rule === 'cycle-depends-on') {
      const refs = prunedDependsOnByStem.get(drop.stem);
      if (refs === undefined) {
        prunedDependsOnByStem.set(drop.stem, [drop.ref]);
      } else {
        refs.push(drop.ref);
      }
    }
  }
  const survivingNodes = rawNodes.filter((n) => validByStem.has(n.stem));

  // Identity and ordering are separate: retain the canonical stems/keys, while
  // explicitly sorting projects by key and nodes by (key, numeric seq).
  survivingProjects.sort((a, b) => cmpStr(a.key, b.key));
  survivingNodes.sort((a, b) => (a.key === b.key ? a.seq - b.seq : cmpStr(a.key, b.key)));

  const projects: Project[] = survivingProjects.map((p) => decodeProject(p.key, p.fm));

  const nodes: Node[] = [];
  const edges: Dependency[] = [];
  const nodeTags = new Map<string, NodeTag[]>();
  const nodeFm = new Map<string, Record<string, unknown>>();
  const projectFm = new Map<string, Record<string, unknown>>();
  const prunedDependsOn = new Map<string, readonly string[]>();
  const pathByStem = new Map<string, string>();
  survivingProjects.forEach((p) => {
    projectFm.set(p.key, p.fm);
    pathByStem.set(p.key, p.path);
  });
  for (const n of survivingNodes) {
    nodeFm.set(n.stem, n.fm);
    pathByStem.set(n.stem, n.path);
    const pruned = prunedDependsOnByStem.get(n.stem);
    if (pruned !== undefined) {
      prunedDependsOn.set(n.stem, pruned);
    }
    // The validator already vetted this node's referential edges (its project is
    // present, parent/depends_on resolve to survivors), so the lookups below
    // cannot miss on vault data. A miss here would mean the validator and this
    // build disagree — an internal contract break, not vault corruption — so the
    // remaining invariants guard the seam, never the record. Field validity is now
    // the validator's too (MMR-177): the lifecycle/hold `enumFieldStrict` calls
    // never throw for a survivor (their bad nodes are dropped) — they stay strict
    // as a seam backstop — and a foreign priority/size is nulled, not thrown.
    const refs = validByStem.get(n.stem);
    if (refs === undefined || !projectFm.has(n.key)) {
      throw invariant(
        `node ${n.stem} survived validation but is unresolvable (project ${n.key})`,
        'the validator must only return nodes whose project and edges resolve',
      );
    }

    // parent: the validator's parent is null (a root, or a dropped edge floated to
    // root) or a surviving `KEY-seq` — so it always resolves to another node.
    const parentStem = refs.parent;
    let parentId: string | null = null;
    if (parentStem !== null && parseId(parentStem) !== null) {
      if (!validByStem.has(parentStem)) {
        throw invariant(
          `node ${n.stem} has validated parent ${parentStem}, which is not in the subgraph`,
          'a validated parent must resolve to a surviving node',
        );
      }
      parentId = parentStem;
    }

    nodes.push(decodeNode(n.stem, n.key, n.seq, n.type, n.fm, parentId));

    // The validator already dropped dangling prerequisites, self-dependencies, and
    // cycle-closing edges (acyclicity, MMR-174), and deduped the list, so every
    // stem here resolves to a *distinct* survivor. Both lookups below are seam
    // invariants, never record throws: a miss or a self-edge on validated data
    // would mean the validator and this build disagree, not that the vault is bad.
    // The prereqIds set keeps the reader's own idempotence — the same collapse
    // a (node_id, depends_on_node_id) unique key would enforce.
    const prereqIds = new Set<string>();
    for (const prereqStem of refs.dependsOn) {
      if (!validByStem.has(prereqStem)) {
        throw invariant(
          `node ${n.stem} has validated prerequisite ${prereqStem}, which is not in the subgraph`,
          'a validated prerequisite must resolve to a surviving node',
        );
      }
      if (prereqStem === n.stem) {
        throw invariant(
          `node ${n.stem} has a validated self-dependency`,
          'acyclicity validation (MMR-174) must drop a self-dependency before the reader',
        );
      }
      if (!prereqIds.has(prereqStem)) {
        prereqIds.add(prereqStem);
        edges.push({ depends_on_node_id: prereqStem, node_id: n.stem });
      }
    }

    const tags = stringList(n.fm.tags);
    if (tags.length > 0) {
      nodeTags.set(n.stem, toTagRecords(tags, str(n.fm.created) ?? ''));
    }
  }

  const projectTags = new Map<string, NodeTag[]>();
  survivingProjects.forEach((p) => {
    const tags = stringList(p.fm.tags);
    if (tags.length > 0) {
      projectTags.set(p.key, toTagRecords(tags, str(p.fm.created) ?? ''));
    }
  });

  return {
    collidingPathsByStem,
    nodeFm,
    pathByStem,
    projectFm,
    prunedDependsOn,
    // The validator's own drop tally (MMR-184) — free off this load's already-run
    // `validate()` pass; the CLI nudges `mimir doctor` from it, no extra vault read.
    workingSet: {
      edges,
      issueCount: validated.dropped.length,
      nodeTags,
      nodes,
      projectTags,
      projects,
    },
  };
}

/**
 * The lightweight all-projects read (MMR-251): ONE `type:project` find, decoded to
 * {@link Project} records — the seed resolving seam's requester/board-active view
 * WITHOUT paying a whole-vault node load. Validator parity for identity: a project
 * `key` carried by more than one document is ambiguous and dropped (mirroring the
 * snapshot's `duplicate-stem` exclusion), so a colliding key never reads as a known
 * board. Archived projects are included (`archived_at` carries the axis); the caller
 * applies the active-only visibility. Deterministic key order.
 */
export async function loadProjectsOverNorn(client: NornClient): Promise<Project[]> {
  const docs = await client.find({ eq: ['type:project'], no_limit: true });
  const byKey = new Map<string, Record<string, unknown>>();
  const sources: { stem: string }[] = [];
  for (const doc of docs) {
    const fm = doc.frontmatter;
    if (fm === undefined || str(fm.type) !== 'project') {
      continue;
    }
    const key = str(fm.key);
    if (key === null || key === '') {
      continue;
    }
    // One source per document (stem = the project key), so a key carried by more than
    // one doc collides; `byKey` keeps the first (a colliding key is dropped below).
    sources.push({ stem: key });
    if (!byKey.has(key)) {
      byKey.set(key, fm);
    }
  }
  // Validity derives from the SHARED project-presence/duplicate rule the whole-vault
  // snapshot uses (MMR-251) — a colliding key reads as no known board, identically.
  const present = presentProjectKeys([...byKey.keys()], sources);
  return [...byKey]
    .filter(([key]) => present.has(key))
    .map(([key, fm]) => decodeProject(key, fm))
    .toSorted((a, b) => cmpStr(a.key, b.key));
}

/**
 * The project-scoped node read (MMR-251): the nodes of the named projects only —
 * the seed resolving seam's spawned-target settledness closure, WITHOUT a
 * whole-vault load. A container spawned target's settledness is a rollup over its
 * own subtree, all within its project, so loading the target's PROJECT is the
 * closure; a task target needs only itself, likewise in-project. Routes through the
 * shared {@link validate} + {@link decodeNode}, so a scoped node reads byte-identical
 * to the whole-vault snapshot and the validator's drops agree (a bad-lifecycle or
 * duplicate node is dropped, so a `spawned` ref at it dangles and prunes, exactly as
 * the doctor validator would). Edges cross project boundaries but settledness never
 * consults them (a task is settled by its own lifecycle; a container by its
 * descendant tasks' terminal-ness), so they are deliberately not projected.
 *
 * Presence is NOT trusted from the requested keys: `validProjectKeys` is the valid
 * project-key set the caller already derived from its validated projects read
 * (MMR-251), so a spawned target whose project doc is missing or duplicate-key is
 * dropped here (missing-project) exactly as the whole-vault snapshot drops it — the
 * scoped and whole-vault paths agree, and the resolving seam prunes the ref either way.
 */
export async function loadNodesForProjectsOverNorn(
  client: NornClient,
  projectKeys: readonly string[],
  validProjectKeys: ReadonlySet<string>,
): Promise<Node[]> {
  const keys = [...new Set(projectKeys)];
  if (keys.length === 0) {
    return [];
  }
  // One `type in {task,phase,initiative}` find per project key (the proven
  // type+project selector shape). The common case is one key (spawned in-board).
  const docLists = await Promise.all(
    keys.map((key) =>
      client.find({ eq: [`project:${key}`], in: ['type:task,phase,initiative'], no_limit: true }),
    ),
  );
  const rawNodes: NodeDoc[] = [];
  for (const doc of docLists.flat()) {
    const fm = doc.frontmatter;
    if (fm === undefined) {
      continue;
    }
    const type = str(fm.type);
    if (type !== 'task' && type !== 'phase' && type !== 'initiative') {
      continue;
    }
    const stem = stemOf(doc.path);
    const ref = parseId(stem);
    if (ref !== null) {
      rawNodes.push({ fm, key: ref.key, path: doc.path, seq: ref.seq, stem, type });
    }
  }
  // Validate the scoped subgraph, with presence taken from the caller's VALIDATED
  // project keys — not the requested keys: a target whose project is missing/duplicate
  // is not present, so its node drops (missing-project) exactly as the whole-vault path
  // drops it. Field validity drops a bad-lifecycle/hold node, duplicate stems drop an
  // ambiguous identity, dangling edges to out-of-scope nodes prune (unused here).
  const validated = validate({
    nodes: rawNodes.map((n) => nodeRefsOf(n.fm, n.key, n.stem, n.type, n.path)),
    projectKeys: keys.filter((key) => validProjectKeys.has(key)),
    sources: rawNodes.map((n) => ({ kind: 'node' as const, path: n.path, stem: n.stem })),
  });
  const validByStem = new Map(validated.nodes.map((r) => [r.stem, r]));
  return rawNodes
    .filter((n) => validByStem.has(n.stem))
    .map((n) => {
      const parent = validByStem.get(n.stem)?.parent ?? null;
      const parentId = parent !== null && parseId(parent) !== null ? parent : null;
      return decodeNode(n.stem, n.key, n.seq, n.type, n.fm, parentId);
    });
}
