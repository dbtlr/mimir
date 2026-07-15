import { isDeepStrictEqual } from 'node:util';

import type { AnnotationView, HistoryEntry } from '@mimir/contract';

import { createNornArtifactStore } from '../core/artifacts';
import { createNornBodySectionStore } from '../core/body-sections';
import { invariant, validation } from '../core/errors';
import {
  ANNOTATIONS_HEADING,
  DESCRIPTION_HEADING,
  HISTORY_HEADING,
  renderAnnotationRecord,
  renderDescriptionSection,
  renderHistoryBody,
  renderHistoryRecord,
  renderNodeBody,
} from '../core/history-codec';
import { parseId } from '../core/ids';
import type { Dependency, Node, Project } from '../core/model';
import { createNornSeedStore } from '../core/seeds';
import type {
  NewAnnotationRecord,
  NewTransitionRecord,
  NodeTag,
  Store,
  StoreWriter,
  WorkingSet,
} from '../core/store';
import type { NornSnapshot } from '../core/store-norn';
import { loadNornSnapshot, loadWorkingSetOverNorn } from '../core/store-norn';
import { now } from '../core/time';
import { createNornTransitionsFeed } from '../core/transitions';
import { nodeFrontmatter, projectFrontmatter } from '../core/vault-frontmatter';
import type { NornClient, NornDocument } from './client';
import { stemOf } from './decode';
import type { MigrationOp } from './plan';
import {
  addFrontmatter,
  appendToSection,
  createDocument,
  migrationPlan,
  removeFrontmatter,
  replaceSection,
  setFrontmatter,
} from './plan';

/**
 * The Norn-backed `Store.transact` + `StoreWriter` (MMR-153, ADR 0016 Phase 3
 * write path). The model is: read one snapshot → run the verb, accumulating
 * intended effects over an in-memory overlay → collapse every effect into ONE
 * atomic {@link import('./plan').MigrationPlan} → `vault.apply` → replay on drift.
 * It is the sole `Store.transact` implementation (MMR-234) — the verbs compose
 * the same `StoreWriter` vocabulary regardless.
 *
 * Every verb reduces to one document (design §95): a node's tags, History, and
 * parent all live in its own file, so a whole `transact` coalesces per target
 * document — a create becomes one `create_document`, a mutation becomes one
 * `set_frontmatter` per changed field (carrying the snapshot value as the
 * compare-and-set `expected_old_value`) plus one `append_to_section` per logged
 * transition. Because `vault.apply` refuses on any CAS mismatch, a concurrent
 * write is caught and the deterministic verb is replayed against a fresh
 * snapshot.
 *
 * Identity is canonical throughout. Existing documents resolve through the
 * snapshot's stem-to-path locator. A new node remains private to this writer
 * until Norn resolves `{{seq}}`; the structured apply-report stem supplies its
 * final echo, followed by a targeted survivor read rather than another
 * whole-vault load.
 */

const MAX_ATTEMPTS = 5;

/** A queued append under a document's `## History` section. */
type HistoryAppend = HistoryEntry;

/** A queued append under a node's `## Annotations` section. */
type AnnotationAppend = AnnotationView;

/** Accumulated mutation of one EXISTING (snapshot) document. */
type Mutation = {
  /** Frontmatter field names whose overlay value must be reconciled to disk. */
  dirty: Set<string>;
  history: HistoryAppend[];
  /** Queued `## Annotations` appends (nodes only; projects carry no annotations). */
  annotations: AnnotationAppend[];
};

/** A queued create of one NEW document, private to the writer. */
type Create = {
  /** Exact `create_document.new_value`, retained for post-apply verification. */
  createdPayload?: { body: string; frontmatter: Record<string, unknown> };
  tags: NodeTag[];
  /** The path template handed to `create_document`; a node carries `{{seq}}`. */
  pathTemplate: string;
  /**
   * The plan-operations index this create's `create_document` op occupies —
   * stamped by {@link Accumulator.buildOperations} at emit time. norn reports
   * each op's `op_id` as its plan position, so this is the correlation key
   * {@link extractResolvedStems} reads the resolved seq back on. Captured at emit
   * rather than reconstructed from the creates-array index, so it stays correct
   * if the emit order or op-per-create count ever changes.
   */
  opId?: number;
} & ({ targetKind: 'node'; target: Node } | { targetKind: 'project'; target: Project });

/** Creation tags are set-valued; keep each tag's first timestamp and input position. */
function creationTags(tags: readonly string[], createdAt: string): NodeTag[] {
  return [...new Set(tags)].map((tag) => ({ created_at: createdAt, tag }));
}

/** The frontmatter field a node patch column maps onto (identity but for parent). */
function nodePatchField(column: string): string {
  return column === 'parent_id' ? 'parent' : column;
}

export function createNornWriteStore(client: NornClient, vaultRoot: string): Store {
  return {
    artifacts: createNornArtifactStore(client),
    bodySections: createNornBodySectionStore(client),
    loadWorkingSet: () => loadWorkingSetOverNorn(client),
    seeds: createNornSeedStore(client, vaultRoot),
    transact: (fn) => runTransact(client, vaultRoot, fn),
    transitions: createNornTransitionsFeed(client),
  };
}

async function runTransact<T>(
  client: NornClient,
  vaultRoot: string,
  fn: (w: StoreWriter) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await loadNornSnapshot(client);
    const acc = new Accumulator(snapshot);
    const result = await fn(acc.writer);
    const operations = acc.buildOperations();
    if (operations.length === 0) {
      return result; // a pure-read `transact` (e.g. a guard that threw nothing)
    }
    const plan = migrationPlan({ generator: 'mimir', operations, vaultRoot });
    // norn 0.45.1 (NRN-219): a precondition refusal sets `isError: true` but
    // PRESERVES the structured report, which `applyPlan` returns (tolerating the
    // error signal) rather than throwing — so classify the outcome. A genuine
    // tool/connection error (no report) still throws and is terminal (propagates).
    const report = await client.applyPlan(plan, true);
    const verdict = classifyApply(report);
    if (verdict.kind === 'drift') {
      // The vault moved under the snapshot — record it and replay from a fresh
      // read. On the FINAL attempt the loop falls through to the exhaustion
      // throw below, never leaking the raw drift detail.
      lastError = new Error(verdict.detail);
      continue;
    }
    if (verdict.kind === 'failed') {
      // A non-drift refusal (deterministic — blind retry won't change it) or a
      // partial apply (some ops wrote — NOT byte-identical, not safe to replay).
      // A norn-side refusal (bad input / precondition / conflict), not a mimir
      // invariant breach — surface it as a `validation` error, as the pre-0.45
      // `isError` path did, so it doesn't read as an internal mimir bug.
      throw validation('the node write path apply did not complete', verdict.detail);
    }
    const resolvedStems = extractResolvedStems(report, acc.creates);
    await verifyCreates(client, acc.creates, resolvedStems);
    return acc.resolveResult(result, resolvedStems);
  }
  throw invariant(
    'the node write path exhausted its drift retries',
    lastError instanceof Error ? lastError.message : undefined,
  );
}

/** norn's stable CAS-refusal error codes (kebab-case, NRN-150) — the machine
 * signal a concurrent write drifted the snapshot. A `refused` apply whose failed
 * ops all carry one of these is safe to reload-and-replay (byte-identical, nothing
 * written); any other refusal reason is deterministic and must not be replayed. */
const DRIFT_CODES: ReadonlySet<string> = new Set([
  'expected-old-value-mismatch',
  'stale-document-hash',
]);

/** The verdict on a `vault.apply` report (norn 0.45 in-band outcome). `drift` =
 * a CAS refusal → reload and replay; `failed` = a deterministic refusal or a
 * partial write → terminal (propagate); `applied` = proceed. */
type ApplyVerdict =
  | { kind: 'applied' }
  | { kind: 'drift'; detail: string }
  | { kind: 'failed'; detail: string };

/**
 * Classify a `vault.apply` report by its `outcome` (norn 0.45, NRN-150/NRN-183).
 * Replaces the pre-0.45 `isDriftError` prose match: drift now surfaces as a
 * structured `error.code`, so we branch on the code, never on human-facing text.
 * Only an explicit `outcome: 'applied'` is success — any outcome we cannot
 * positively confirm as applied (a `failed` partial, a non-drift refusal, or an
 * unrecognized/degraded report) is terminal, so a write we can't confirm is never
 * reported as success.
 */
function classifyApply(report: unknown): ApplyVerdict {
  const root = isRecord(report) && isRecord(report.report) ? report.report : report;
  const outcome = isRecord(root) && typeof root.outcome === 'string' ? root.outcome : undefined;
  if (outcome === 'applied') {
    return { kind: 'applied' };
  }
  const errors = failedOpErrors(root);
  const detail =
    errors
      .map((e) => e.message)
      .filter(Boolean)
      .join('; ') || `apply outcome: ${outcome ?? 'unrecognized'}`;
  // Replay ONLY a pure CAS-drift refusal (byte-identical, nothing written): there
  // must be a failed op and EVERY failed op must carry a CAS code. A mixed refusal
  // (a CAS op alongside a code-less or non-CAS failure) is NOT pure drift — a blind
  // replay can't clear the other failure — so it falls through to terminal.
  if (
    outcome === 'refused' &&
    errors.length > 0 &&
    errors.every((e) => e.code !== null && DRIFT_CODES.has(e.code))
  ) {
    return { detail, kind: 'drift' };
  }
  return { detail, kind: 'failed' };
}

/** The `{ code, message }` of each failed op in an apply report (`status: 'failed'`
 * or a present `error`), for {@link classifyApply}'s drift-vs-terminal decision. */
function failedOpErrors(root: unknown): { code: string | null; message: string | null }[] {
  if (!isRecord(root) || !Array.isArray(root.operations)) {
    return [];
  }
  return root.operations.flatMap((op) => {
    if (!isRecord(op)) {
      return [];
    }
    const error = isRecord(op.error) ? op.error : undefined;
    if (op.status !== 'failed' && error === undefined) {
      return [];
    }
    return [
      {
        code: error !== undefined && typeof error.code === 'string' ? error.code : null,
        message: error !== undefined && typeof error.message === 'string' ? error.message : null,
      },
    ];
  });
}

/**
 * The accumulating `StoreWriter`: point reads for snapshot-backed records and
 * newly inserted projects serve from a mutable overlay (the in-transaction
 * read-your-writes view the verbs expect). A pending node has no canonical stem
 * until apply and remains private as the value returned by `insertNode`; it is
 * intentionally absent from id-based point reads. Write primitives record
 * intended effects keyed by target document without touching Norn.
 */
class Accumulator {
  readonly writer: StoreWriter;
  readonly creates: Create[] = [];

  private readonly snapshot: NornSnapshot;
  private readonly nodes: Map<string, Node>;
  private readonly projects: Map<string, Project>;
  private edges: Dependency[];
  private readonly nodeTags: Map<string, NodeTag[]>;
  private readonly projectTags: Map<string, NodeTag[]>;
  private readonly nodeMutations = new Map<string, Mutation>();
  private readonly projectMutations = new Map<string, Mutation>();

  constructor(snapshot: NornSnapshot) {
    this.snapshot = snapshot;
    const ws = snapshot.workingSet;
    this.nodes = new Map(ws.nodes.map((n) => [n.id, { ...n }]));
    this.projects = new Map(ws.projects.map((p) => [p.key, { ...p }]));
    this.edges = ws.edges.map((e) => ({ ...e }));
    this.nodeTags = new Map(
      [...ws.nodeTags].map(([id, tags]) => [id, tags.map((t) => ({ ...t }))]),
    );
    this.projectTags = new Map(
      [...ws.projectTags].map(([id, tags]) => [id, tags.map((t) => ({ ...t }))]),
    );
    this.writer = this.buildWriter();
  }

  private overlayWorkingSet(): WorkingSet {
    return {
      edges: this.edges.map((e) => ({ ...e })),
      nodeTags: new Map(this.nodeTags),
      nodes: [...this.nodes.values()],
      projectTags: new Map(this.projectTags),
      projects: [...this.projects.values()],
    };
  }

  private mutationOf(map: Map<string, Mutation>, id: string): Mutation {
    let mutation = map.get(id);
    if (mutation === undefined) {
      mutation = { annotations: [], dirty: new Set(), history: [] };
      map.set(id, mutation);
    }
    return mutation;
  }

  private buildWriter(): StoreWriter {
    return {
      allocateArtifactSeq: () => Promise.resolve(0),
      appendTransition: (row) => this.appendTransition(row),
      deleteDependency: (edge) => this.deleteDependency(edge),
      deleteTags: (entityType, entityId, tags) => this.deleteTags(entityType, entityId, tags),
      hasIdentityCollision: (stem) => Promise.resolve(this.snapshot.collidingPathsByStem.has(stem)),
      insertAnnotation: (row) => this.insertAnnotation(row),
      insertArtifact: () =>
        Promise.reject(invariant('artifact writes route through the artifact seam, not the plan')),
      insertDependency: (edge) => this.insertDependency(edge),
      insertNode: (row) => this.insertNode(row),
      insertProject: (row) => this.insertProject(row),
      insertTag: (row) => this.applyTag(row.entity_type, row.entity_id, row.tag),
      linkArtifact: () =>
        Promise.reject(invariant('artifact links route through the artifact seam, not the plan')),
      listChildren: (parentId) =>
        Promise.resolve(
          [...this.nodes.values()].filter((n) => n.parent_id === parentId).map((n) => n.id),
        ),
      listPrereqsOf: (nodeId) =>
        Promise.resolve(
          this.edges.filter((e) => e.node_id === nodeId).map((e) => e.depends_on_node_id),
        ),
      listRankedTasks: (projectId) =>
        Promise.resolve(
          [...this.nodes.values()]
            .filter((n) => n.project_id === projectId)
            .flatMap((n) => (n.rank === null ? [] : [{ id: n.id, rank: n.rank, seq: n.seq }]))
            .toSorted((a, b) => (a.rank === b.rank ? a.seq - b.seq : a.rank - b.rank)),
        ),
      loadArtifact: () => Promise.resolve(undefined),
      loadNode: (id) => Promise.resolve(this.cloneNode(id)),
      loadProject: (key) => Promise.resolve(this.cloneProject(this.projects.get(key))),
      loadWorkingSet: () => Promise.resolve(this.overlayWorkingSet()),
      updateArtifact: () =>
        Promise.reject(invariant('artifact writes route through the artifact seam, not the plan')),
      updateNode: (id, patch) => this.updateNode(id, patch),
      updateProject: (id, patch) => this.updateProject(id, patch),
    };
  }

  private cloneNode(id: string): Node | undefined {
    const node = this.nodes.get(id);
    return node === undefined ? undefined : { ...node };
  }

  private cloneProject(project: Project | undefined): Project | undefined {
    return project === undefined ? undefined : { ...project };
  }

  // ── Write primitives (record effects + update overlay) ──────────────────

  private insertNode(row: {
    project_id: string;
    type: Node['type'];
    parent_id: string | null;
    tags?: string[];
    title: string;
    description?: string | null;
    summary?: string | null;
    lifecycle?: Node['lifecycle'];
    hold?: Node['hold'];
    priority?: Node['priority'];
    size?: Node['size'];
    rank?: number | null;
    external_ref?: string | null;
    upstream?: string | null;
    target?: string | null;
    open_ended?: boolean | null;
  }): Promise<Node> {
    const project = this.projects.get(row.project_id);
    if (project === undefined) {
      return Promise.reject(invariant('the project vanished mid-transaction'));
    }
    const timestamp = now();
    const node: Node = {
      completed_at: null,
      created_at: timestamp,
      description: row.description ?? null,
      external_ref: row.external_ref ?? null,
      hold: row.hold ?? (row.type === 'task' ? 'none' : null),
      hold_reason: null,
      id: '',
      lifecycle: row.lifecycle ?? null,
      open_ended: row.open_ended ?? null,
      parent_id: row.parent_id,
      priority: row.priority ?? null,
      project_id: row.project_id,
      rank: row.rank ?? null,
      seq: 0,
      size: row.size ?? null,
      summary: row.summary ?? null,
      target: row.target ?? null,
      title: row.title,
      type: row.type,
      updated_at: timestamp,
      upstream: row.upstream ?? null,
    };
    this.creates.push({
      pathTemplate: `${project.key}/${project.key}-{{seq}}.md`,
      tags: creationTags(row.tags ?? [], timestamp),
      target: node,
      targetKind: 'node',
    });
    return Promise.resolve(node);
  }

  private insertProject(row: {
    key: string;
    name: string;
    description: string | null;
    tags?: string[];
  }): Promise<Project> {
    const timestamp = now();
    const project: Project = {
      archived_at: null,
      created_at: timestamp,
      description: row.description,
      key: row.key,
      name: row.name,
      updated_at: timestamp,
    };
    this.projects.set(project.key, project);
    this.creates.push({
      pathTemplate: `${project.key}/${project.key}.md`,
      tags: creationTags(row.tags ?? [], timestamp),
      target: project,
      targetKind: 'project',
    });
    return Promise.resolve(project);
  }

  private updateNode(id: string, patch: Record<string, unknown>): Promise<void> {
    const node = this.nodes.get(id);
    if (node === undefined) {
      return Promise.reject(invariant('the record vanished mid-transaction'));
    }
    Object.assign(node, patch);
    if (this.snapshot.pathByStem.has(id)) {
      const mutation = this.mutationOf(this.nodeMutations, id);
      for (const column of Object.keys(patch)) {
        mutation.dirty.add(nodePatchField(column));
      }
    }
    return Promise.resolve();
  }

  private updateProject(id: string, patch: Record<string, unknown>): Promise<void> {
    const project = this.projects.get(id);
    if (project === undefined) {
      return Promise.reject(invariant('the record vanished mid-transaction'));
    }
    Object.assign(project, patch);
    if (this.snapshot.pathByStem.has(id)) {
      const mutation = this.mutationOf(this.projectMutations, id);
      for (const column of Object.keys(patch)) {
        mutation.dirty.add(column);
      }
    }
    return Promise.resolve();
  }

  private insertDependency(edge: Dependency): Promise<void> {
    const exists = this.edges.some(
      (e) => e.node_id === edge.node_id && e.depends_on_node_id === edge.depends_on_node_id,
    );
    if (!exists) {
      this.edges.push({ ...edge });
    }
    this.markDependsOnDirty(edge.node_id);
    return Promise.resolve();
  }

  private deleteDependency(edge: Dependency): Promise<boolean> {
    const before = this.edges.length;
    this.edges = this.edges.filter(
      (e) => !(e.node_id === edge.node_id && e.depends_on_node_id === edge.depends_on_node_id),
    );
    const removed = this.edges.length < before;
    if (removed) {
      this.markDependsOnDirty(edge.node_id);
    }
    return Promise.resolve(removed);
  }

  private markDependsOnDirty(nodeId: string): void {
    if (this.snapshot.pathByStem.has(nodeId)) {
      this.mutationOf(this.nodeMutations, nodeId).dirty.add('depends_on');
    }
  }

  private applyTag(
    entityType: 'node' | 'project' | 'artifact',
    entityId: string,
    tag: string,
  ): Promise<void> {
    if (entityType === 'artifact') {
      return Promise.reject(
        invariant('artifact tags route through the artifact seam, not the plan'),
      );
    }
    const map = entityType === 'node' ? this.nodeTags : this.projectTags;
    const tags = map.get(entityId) ?? [];
    if (!tags.some((t) => t.tag === tag)) {
      tags.push({ created_at: now(), tag });
    }
    map.set(entityId, tags);
    if (this.snapshot.pathByStem.has(entityId)) {
      const mutations = entityType === 'node' ? this.nodeMutations : this.projectMutations;
      this.mutationOf(mutations, entityId).dirty.add('tags');
    }
    return Promise.resolve();
  }

  private deleteTags(
    entityType: 'node' | 'project' | 'artifact',
    entityId: string,
    tags: string[],
  ): Promise<number> {
    if (entityType === 'artifact') {
      return Promise.resolve(0);
    }
    const map = entityType === 'node' ? this.nodeTags : this.projectTags;
    const current = map.get(entityId) ?? [];
    const remove = new Set(tags);
    const kept = current.filter((t) => !remove.has(t.tag));
    const removed = current.length - kept.length;
    map.set(entityId, kept);
    if (removed > 0 && this.snapshot.pathByStem.has(entityId)) {
      const mutations = entityType === 'node' ? this.nodeMutations : this.projectMutations;
      this.mutationOf(mutations, entityId).dirty.add('tags');
    }
    return Promise.resolve(removed);
  }

  private appendTransition(row: NewTransitionRecord): Promise<void> {
    const entry: HistoryEntry = {
      at: row.at, // core-stamped by `logTransition` (MMR-173); persisted verbatim
      from: row.from_value,
      kind: row.kind,
      reason: row.reason ?? null,
      to: row.to_value,
    };
    // Fail loud on an unresolvable target: a transition against a same-transact
    // create (which has no canonical stem yet) or a node/project absent from the
    // snapshot must not be dropped — that would lose History. Creation itself
    // is not a transition (ADR 0003).
    if (row.node_id != null) {
      if (!this.snapshot.pathByStem.has(row.node_id) || !this.nodes.has(row.node_id)) {
        throw invariant('a transition targets a node absent from the snapshot');
      }
      this.mutationOf(this.nodeMutations, row.node_id).history.push(entry);
    } else if (row.project_id != null) {
      if (!this.snapshot.pathByStem.has(row.project_id) || !this.projects.has(row.project_id)) {
        throw invariant('a transition targets a project absent from the snapshot');
      }
      this.mutationOf(this.projectMutations, row.project_id).history.push(entry);
    } else {
      throw invariant('a transition targets neither a node nor a project');
    }
    return Promise.resolve();
  }

  /**
   * Queue a node's `## Annotations` append (MMR-154). The created-at is
   * core-supplied (MMR-173) — the mutation layer stamps it (the `stamp`
   * invariant) — and the record flushes as one `append_to_section`
   * op, the same mechanism `## History` uses. Annotations are node-only; a
   * target absent from the snapshot fails loud rather than silently dropping the
   * note.
   */
  private insertAnnotation(row: NewAnnotationRecord): Promise<void> {
    if (!this.snapshot.pathByStem.has(row.node_id) || !this.nodes.has(row.node_id)) {
      throw invariant('an annotation targets a node absent from the snapshot');
    }
    this.mutationOf(this.nodeMutations, row.node_id).annotations.push({
      content: row.content,
      createdAt: row.created_at,
    });
    return Promise.resolve();
  }

  // ── Plan build (coalesce every effect into one op-set per document) ──────

  /** Validate and return an existing node's canonical stem. */
  private stemOf(nodeId: string): string {
    if (!this.nodes.has(nodeId)) {
      throw invariant('a relation referenced a node absent from the snapshot');
    }
    return nodeId;
  }

  private nodeRelations(
    node: Node,
    createTags?: NodeTag[],
  ): {
    projectKey: string;
    parentStem: string | null;
    dependsOn: string[];
    tags: NodeTag[];
  } {
    // Re-merge any `depends_on` refs the validator pruned on load (a dangling or
    // cycle-broken edge the working set omits) so rewriting the field preserves
    // them on disk instead of silently erasing corruption `mimir doctor` surfaces
    // (MMR-186). Empty for a created node (no snapshot entry) and for a clean
    // vault. Deduped and sorted with the live edges for stable, idempotent output:
    // a pruned ref is disjoint from the live edges within any single snapshot
    // (`depend`'s cycle guard blocks re-adding a cut edge in the same transact),
    // but the dedup keeps the write single-valued regardless, so the invariant
    // stays local rather than leaning on a guard two modules away.
    const preserved = this.snapshot.prunedDependsOn.get(node.id) ?? [];
    const liveDeps = this.edges
      .filter((e) => e.node_id === node.id)
      .map((e) => this.stemOf(e.depends_on_node_id));
    const dependsOn = [...new Set([...liveDeps, ...preserved])].toSorted((a, b) =>
      a.localeCompare(b),
    );
    const tags = (createTags ?? this.nodeTags.get(node.id) ?? []).toSorted((a, b) =>
      a.tag.localeCompare(b.tag),
    );
    if (!this.projects.has(node.project_id)) {
      throw invariant('a node referenced a project absent from the snapshot');
    }
    return {
      dependsOn,
      parentStem: node.parent_id === null ? null : this.stemOf(node.parent_id),
      projectKey: node.project_id,
      tags,
    };
  }

  buildOperations(): MigrationOp[] {
    const operations: MigrationOp[] = [];

    // Creates first, so a mutation's target already exists on disk. Stamp each
    // create with the op index it lands at — the `op_id` norn echoes on its
    // report op, the key the seq resolution reads back on.
    for (const create of this.creates) {
      create.opId = operations.length;
      if (create.targetKind === 'node') {
        const node = create.target;
        const fm = nodeFrontmatter(node, this.nodeRelations(node, create.tags));
        const body = renderNodeBody(node.description);
        create.createdPayload = { body, frontmatter: fm };
        operations.push(createDocument(create.pathTemplate, fm, body));
      } else {
        const project = create.target;
        const tags = create.tags.toSorted((a, b) => a.tag.localeCompare(b.tag));
        const fm = projectFrontmatter(project, tags);
        const body = renderHistoryBody();
        create.createdPayload = { body, frontmatter: fm };
        operations.push(createDocument(create.pathTemplate, fm, body));
      }
    }

    for (const [id, mutation] of this.nodeMutations) {
      const node = this.nodes.get(id);
      if (node === undefined) {
        throw invariant('a mutated node vanished from the overlay');
      }
      const path = this.snapshot.pathByStem.get(id);
      if (path === undefined) {
        throw invariant('a mutated node has no path in the transaction snapshot');
      }
      const finalFm = nodeFrontmatter(node, this.nodeRelations(node));
      const rawFm = this.snapshot.nodeFm.get(id) ?? {};
      this.emitFieldOps(operations, path, mutation.dirty, finalFm, rawFm);
      // A `description` edit rewrites the `## Task Description` body section
      // `renderNodeBody` seeded at create — the authoritative home for the prose
      // (MMR-162; description is no longer frontmatter, so `emitFieldOps` emits no
      // frontmatter op for it — the body write below is the whole edit).
      if (mutation.dirty.has('description')) {
        operations.push(
          replaceSection(path, DESCRIPTION_HEADING, renderDescriptionSection(node.description)),
        );
      }
      this.emitHistory(operations, path, mutation.history);
      this.emitAnnotations(operations, path, mutation.annotations);
    }

    for (const [id, mutation] of this.projectMutations) {
      const project = this.projects.get(id);
      if (project === undefined) {
        throw invariant('a mutated project vanished from the overlay');
      }
      const path = this.snapshot.pathByStem.get(id);
      if (path === undefined) {
        throw invariant('a mutated project has no path in the transaction snapshot');
      }
      const tags = (this.projectTags.get(id) ?? []).toSorted((a, b) => a.tag.localeCompare(b.tag));
      const finalFm = projectFrontmatter(project, tags);
      const rawFm = this.snapshot.projectFm.get(id) ?? {};
      this.emitFieldOps(operations, path, mutation.dirty, finalFm, rawFm);
      this.emitHistory(operations, path, mutation.history);
    }

    return operations;
  }

  /**
   * Reconcile each dirty field to its overlay value under compare-and-set. A
   * present→present change is `set_frontmatter` carrying the snapshot value as
   * `expected_old_value`; an absent→present change is `add_frontmatter`; a
   * present→absent change (a cleared column — rank on a terminal task, hold on
   * release) is `remove_frontmatter` guarded by the old value. Norn omits the
   * `none`/null defaults exactly as {@link nodeFrontmatter} does, so "absent" is
   * `finalFm[field] === undefined`.
   */
  private emitFieldOps(
    operations: MigrationOp[],
    path: string,
    dirty: Set<string>,
    finalFm: Record<string, unknown>,
    rawFm: Record<string, unknown>,
  ): void {
    // `type` is immutable and never dirty; guard defensively.
    for (const field of [...dirty].toSorted()) {
      if (field === 'type') {
        continue;
      }
      const present = field in rawFm;
      const finalValue = finalFm[field];
      const finalPresent = field in finalFm;
      if (finalPresent) {
        operations.push(
          present
            ? setFrontmatter(path, field, finalValue, rawFm[field])
            : addFrontmatter(path, field, finalValue),
        );
      } else if (present) {
        operations.push(removeFrontmatter(path, field, rawFm[field]));
      }
    }
  }

  private emitHistory(operations: MigrationOp[], path: string, history: HistoryAppend[]): void {
    for (const entry of history) {
      operations.push(appendToSection(path, HISTORY_HEADING, renderHistoryRecord(entry)));
    }
  }

  private emitAnnotations(
    operations: MigrationOp[],
    path: string,
    annotations: AnnotationAppend[],
  ): void {
    for (const view of annotations) {
      operations.push(appendToSection(path, ANNOTATIONS_HEADING, renderAnnotationRecord(view)));
    }
  }

  /** Fill a created node echo directly from Norn's structured apply report. */
  resolveResult<T>(result: T, resolvedStems: ReadonlyMap<Create, string>): T {
    for (const [create, stem] of resolvedStems) {
      if (create.targetKind !== 'node' || result !== create.target) {
        continue;
      }
      const node = create.target;
      const ref = parseId(stem);
      if (ref === null || ref.key !== node.project_id) {
        throw invariant(`a created node resolved to an unexpected stem: ${stem}`);
      }
      node.id = stem;
      node.seq = ref.seq;
    }
    return result;
  }
}

/** One `create_document` line of a `vault.apply` report, keyed by its `op_id`
 * (norn 0.45 / NRN-175): `stem` is the resolved `KEY-seq` on an applied create;
 * `status` distinguishes `applied` from a `skipped`/not-written op (no stem). */
type ReportOp = { kind: string; status?: string; stem?: string };

/**
 * Map each private queued create to the stem Norn allocated. norn reports
 * every op's `op_id` as its plan position; {@link Accumulator.buildOperations}
 * stamps each create with the op index it emitted at ({@link Create.opId}), so
 * the correlation is that captured index — not a re-derivation from the
 * creates-array position, which would silently desync if the emit order or
 * op-per-create count ever changed. Read the resolved `stem` straight from the
 * correlated op (NRN-175's structured field), not norn's human summary text.
 */
function extractResolvedStems(report: unknown, creates: Create[]): Map<Create, string> {
  const resolved = new Map<Create, string>();
  const byOpId = reportOperations(report);
  for (const create of creates) {
    if (create.targetKind !== 'node') {
      continue;
    }
    // A create MUST resolve its real identity from an applied, structured report
    // op, or the transaction throws before its pending echo can leave the writer.
    if (create.opId === undefined) {
      throw invariant('a created node was not stamped with its plan op_id before apply');
    }
    const op = byOpId.get(String(create.opId));
    if (op === undefined || op.kind !== 'create_document') {
      throw invariant(`a created node has no create_document report op at op_id ${create.opId}`);
    }
    if (op.stem === undefined) {
      throw invariant(
        `a created node's apply-report op carries no resolved stem (status: ${op.status ?? 'unknown'})`,
      );
    }
    const ref = parseId(op.stem);
    if (ref === null) {
      throw invariant(`a created node's resolved stem is not a KEY-seq: ${op.stem}`);
    }
    resolved.set(create, op.stem);
  }
  return resolved;
}

/**
 * Point-verify applied creates before their echo leaves the transaction. The
 * apply report remains the authority for allocated node identity; this targeted
 * `vault.get` only closes the post-apply race where a created stem or its owning
 * project no longer resolves uniquely. It deliberately avoids rebuilding a
 * whole snapshot.
 */
async function verifyCreates(
  client: NornClient,
  creates: readonly Create[],
  resolvedStems: ReadonlyMap<Create, string>,
): Promise<void> {
  if (creates.length === 0) {
    return;
  }
  const projectKeys = new Set<string>();
  for (const create of creates) {
    if (create.targetKind === 'project') {
      projectKeys.add(create.target.key);
    } else {
      projectKeys.add(create.target.project_id);
    }
  }

  // A project is identified by its frontmatter key, not its filename stem: a
  // relocated `OTHER.md` can still carry `key: NEW`. Query that identity
  // directly and without taking another whole-vault snapshot.
  const projectsByKey = new Map<string, NornDocument[]>();
  for (const key of projectKeys) {
    projectsByKey.set(
      key,
      await client.find({ eq: ['type:project', `key:${key}`], no_limit: true }),
    );
  }

  for (const create of creates) {
    const key = create.targetKind === 'project' ? create.target.key : create.target.project_id;
    if ((projectsByKey.get(key) ?? []).length !== 1) {
      throw invariant(
        create.targetKind === 'project'
          ? `created project did not survive uniquely after apply: ${key}`
          : `created node did not survive with one owning project after apply: ${resolvedStems.get(create) ?? 'unknown'}`,
      );
    }
  }

  const targets = new Set<string>();
  for (const projects of projectsByKey.values()) {
    const project = projects[0];
    if (project !== undefined) {
      targets.add(project.path);
    }
  }
  for (const create of creates) {
    if (create.targetKind === 'node') {
      const stem = resolvedStems.get(create);
      if (stem === undefined) {
        throw invariant('a created node has no resolved stem for survivor verification');
      }
      targets.add(stem);
    }
  }
  const records = await client.get([...targets], '.body');
  for (const create of creates) {
    const expected = create.createdPayload;
    if (expected === undefined) {
      throw invariant('a create has no emitted payload for survivor verification');
    }
    const projectKey =
      create.targetKind === 'project' ? create.target.key : create.target.project_id;
    const projectPath = projectsByKey.get(projectKey)?.[0]?.path;
    const projectRecord = records.find(
      (candidate) => isRecord(candidate) && candidate.path === projectPath,
    );
    const projectFm =
      isRecord(projectRecord) && isRecord(projectRecord.frontmatter)
        ? projectRecord.frontmatter
        : undefined;
    if (projectFm?.type !== 'project' || projectFm.key !== projectKey) {
      throw invariant(
        create.targetKind === 'project'
          ? `created project did not survive uniquely after apply: ${projectKey}`
          : `created node did not survive with one owning project after apply: ${resolvedStems.get(create) ?? 'unknown'}`,
      );
    }
    if (create.targetKind === 'project') {
      if (!isDeepStrictEqual(createdPayloadOf(projectRecord), expected)) {
        throw invariant(
          `created project did not survive with its complete payload after apply: ${create.target.key}`,
        );
      }
      continue;
    }
    const stem = resolvedStems.get(create);
    if (stem === undefined) {
      throw invariant('a created node has no resolved stem for survivor verification');
    }
    const nodeMatches = records.filter(
      (record) =>
        isRecord(record) && typeof record.path === 'string' && stemOf(record.path) === stem,
    );
    const nodeRecord = nodeMatches[0];
    if (nodeMatches.length !== 1 || !isDeepStrictEqual(createdPayloadOf(nodeRecord), expected)) {
      throw invariant(
        `created node did not survive with its complete payload after apply: ${stem}`,
      );
    }
  }
}

/** Project a real Norn `.body` record onto the create payload shape. */
function createdPayloadOf(
  record: unknown,
): { body: string; frontmatter: Record<string, unknown> } | undefined {
  if (!isRecord(record) || !isRecord(record.frontmatter) || typeof record.body !== 'string') {
    return undefined;
  }
  return { body: record.body, frontmatter: record.frontmatter };
}

function reportOperations(report: unknown): Map<string, ReportOp> {
  const root = isRecord(report) && isRecord(report.report) ? report.report : report;
  const byOpId = new Map<string, ReportOp>();
  if (!isRecord(root) || !Array.isArray(root.operations)) {
    return byOpId;
  }
  for (const op of root.operations) {
    if (!isRecord(op) || typeof op.op_id !== 'string' || typeof op.kind !== 'string') {
      continue;
    }
    const entry: ReportOp = { kind: op.kind };
    if (typeof op.status === 'string') {
      entry.status = op.status;
    }
    if (typeof op.stem === 'string') {
      entry.stem = op.stem;
    }
    byOpId.set(op.op_id, entry);
  }
  return byOpId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
