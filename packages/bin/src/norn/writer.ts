import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
import { parseId, renderId } from '../core/ids';
import type { Dependency, Node, Project } from '../core/model';
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
import type { NornClient } from './client';
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
 * It is the sibling of {@link import('../core/store-sqlite').createSqliteStore}'s
 * `transact`, behaviorally identical from the verbs' point of view.
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
 * Identity: the vault has no surrogate ids (the stem IS the id), so the reader
 * mints synthetic ints stable per load; this writer resolves those ints to
 * `KEY/KEY-seq.md` paths through the same snapshot. A new node has no seq until
 * Norn allocates it — `create_document`'s `{{seq}}` token is resolved to the
 * next per-project sequence at apply time — so `allocateSeq` hands back a
 * provisional sentinel used only for intra-`transact` overlay identity; the real
 * `KEY-seq` comes back in the apply report and is stitched into the echoed node.
 */

const MAX_ATTEMPTS = 5;

/** A provisional, per-`transact` sentinel id/seq: negative, so it never collides
 * with a snapshot's 1-based synthetic ints (which the reader mints positive). */
type Provisional = number;

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

/** A queued create of one NEW document (provisional id → resolved at apply). */
type Create = {
  targetKind: 'node' | 'project';
  provisionalId: Provisional;
  /** The path template handed to `create_document`; a node carries `{{seq}}`. */
  pathTemplate: string;
};

/** The frontmatter field a node patch column maps onto (identity but for parent). */
function nodePatchField(column: string): string {
  return column === 'parent_id' ? 'parent' : column;
}

export function createNornWriteStore(client: NornClient, vaultRoot: string): Store {
  return {
    artifacts: createNornArtifactStore(client),
    bodySections: createNornBodySectionStore(client),
    loadWorkingSet: () => loadWorkingSetOverNorn(client),
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
    // `vault.apply` runs `create_document` with `parents: false` — the first doc
    // in a new project directory (a project create) would fail on a missing
    // parent. Ensure each create's directory exists on the local vault first;
    // `{{seq}}` only ever occupies the file name, so the directory is concrete.
    ensureCreateDirs(vaultRoot, acc.creates);
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
    const resolvedSeqs = extractResolvedSeqs(report, acc.creates);
    // A create resolves its real KEY-seq/id from a post-apply reload; a pure
    // mutation has nothing to stitch, so skip the extra read.
    const reloaded = resolvedSeqs.size > 0 ? await loadNornSnapshot(client) : undefined;
    return acc.resolveResult(result, resolvedSeqs, reloaded);
  }
  throw invariant(
    'the node write path exhausted its drift retries',
    lastError instanceof Error ? lastError.message : undefined,
  );
}

/** Create each queued document's parent directory on the local vault (idempotent),
 * so `vault.apply`'s `parents: false` create never fails on a missing folder. */
function ensureCreateDirs(vaultRoot: string, creates: Create[]): void {
  for (const create of creates) {
    mkdirSync(join(vaultRoot, dirname(create.pathTemplate)), { recursive: true });
  }
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
 * The accumulating `StoreWriter`: point reads serve from a mutable overlay of
 * the snapshot (so a read after a write in the same `transact` sees the pending
 * change, matching SQLite's in-tx view), and write primitives record intended
 * effects keyed by target document without touching Norn.
 */
class Accumulator {
  readonly writer: StoreWriter;
  readonly creates: Create[] = [];

  private readonly snapshot: NornSnapshot;
  private readonly nodes: Map<number, Node>;
  private readonly projects: Map<number, Project>;
  private readonly projectByKey: Map<string, Project>;
  private edges: Dependency[];
  private readonly nodeTags: Map<number, NodeTag[]>;
  private readonly projectTags: Map<number, NodeTag[]>;
  private readonly nodeMutations = new Map<number, Mutation>();
  private readonly projectMutations = new Map<number, Mutation>();
  private nextProvisional: Provisional = -1;

  constructor(snapshot: NornSnapshot) {
    this.snapshot = snapshot;
    const ws = snapshot.workingSet;
    this.nodes = new Map(ws.nodes.map((n) => [n.id, { ...n }]));
    this.projects = new Map(ws.projects.map((p) => [p.id, { ...p }]));
    this.projectByKey = new Map([...this.projects.values()].map((p) => [p.key, p]));
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

  private mutationOf(map: Map<number, Mutation>, id: number): Mutation {
    let mutation = map.get(id);
    if (mutation === undefined) {
      mutation = { annotations: [], dirty: new Set(), history: [] };
      map.set(id, mutation);
    }
    return mutation;
  }

  private buildWriter(): StoreWriter {
    return {
      allocateArtifactSeq: () => Promise.resolve(this.nextProvisional--),
      allocateSeq: () => Promise.resolve(this.nextProvisional--),
      appendTransition: (row) => this.appendTransition(row),
      deleteDependency: (edge) => this.deleteDependency(edge),
      deleteTags: (entityType, entityId, tags) => this.deleteTags(entityType, entityId, tags),
      insertAnnotation: (row) => this.insertAnnotation(row),
      insertArtifact: () =>
        Promise.reject(invariant('artifact writes route through the artifact seam, not the plan')),
      insertDependency: (edge) => this.insertDependency(edge),
      insertNode: (row) => this.insertNode(row),
      insertProject: (row) => this.insertProject(row),
      insertTag: (row) => this.applyTag(row.entity_type, row.entity_id, row.tag, row.note),
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
      loadProject: (id) => Promise.resolve(this.cloneProject(this.projects.get(id))),
      loadProjectByKey: (key) => Promise.resolve(this.cloneProject(this.projectByKey.get(key))),
      loadWorkingSet: () => Promise.resolve(this.overlayWorkingSet()),
      updateArtifact: () =>
        Promise.reject(invariant('artifact writes route through the artifact seam, not the plan')),
      updateNode: (id, patch) => this.updateNode(id, patch),
      updateProject: (id, patch) => this.updateProject(id, patch),
      upsertTagNote: (row) => this.applyTag(row.entity_type, row.entity_id, row.tag, row.note),
    };
  }

  private cloneNode(id: number): Node | undefined {
    const node = this.nodes.get(id);
    return node === undefined ? undefined : { ...node };
  }

  private cloneProject(project: Project | undefined): Project | undefined {
    return project === undefined ? undefined : { ...project };
  }

  // ── Write primitives (record effects + update overlay) ──────────────────

  private insertNode(row: {
    project_id: number;
    type: Node['type'];
    parent_id: number | null;
    seq: number;
    title: string;
    description?: string | null;
    summary?: string | null;
    lifecycle?: Node['lifecycle'];
    hold?: Node['hold'];
    priority?: Node['priority'];
    size?: Node['size'];
    rank?: number | null;
    external_ref?: string | null;
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
      id: this.nextProvisional--,
      lifecycle: row.lifecycle ?? null,
      open_ended: row.open_ended ?? null,
      parent_id: row.parent_id,
      priority: row.priority ?? null,
      project_id: row.project_id,
      rank: row.rank ?? null,
      seq: row.seq,
      size: row.size ?? null,
      summary: row.summary ?? null,
      target: row.target ?? null,
      title: row.title,
      type: row.type,
      updated_at: timestamp,
    };
    this.nodes.set(node.id, node);
    this.creates.push({
      pathTemplate: `${project.key}/${project.key}-{{seq}}.md`,
      provisionalId: node.id,
      targetKind: 'node',
    });
    return Promise.resolve({ ...node });
  }

  private insertProject(row: {
    key: string;
    name: string;
    description: string | null;
  }): Promise<Project> {
    const timestamp = now();
    const project: Project = {
      archived_at: null,
      created_at: timestamp,
      description: row.description,
      id: this.nextProvisional--,
      key: row.key,
      last_artifact_seq: 0,
      last_seq: 0,
      name: row.name,
      updated_at: timestamp,
    };
    this.projects.set(project.id, project);
    this.projectByKey.set(project.key, project);
    this.creates.push({
      pathTemplate: `${project.key}/${project.key}.md`,
      provisionalId: project.id,
      targetKind: 'project',
    });
    return Promise.resolve({ ...project });
  }

  private updateNode(id: number, patch: Record<string, unknown>): Promise<void> {
    const node = this.nodes.get(id);
    if (node === undefined) {
      return Promise.reject(invariant('the record vanished mid-transaction'));
    }
    Object.assign(node, patch);
    if (id > 0) {
      const mutation = this.mutationOf(this.nodeMutations, id);
      for (const column of Object.keys(patch)) {
        mutation.dirty.add(nodePatchField(column));
      }
    }
    return Promise.resolve();
  }

  private updateProject(id: number, patch: Record<string, unknown>): Promise<void> {
    const project = this.projects.get(id);
    if (project === undefined) {
      return Promise.reject(invariant('the record vanished mid-transaction'));
    }
    Object.assign(project, patch);
    if (id > 0) {
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

  private markDependsOnDirty(nodeId: number): void {
    if (nodeId > 0) {
      this.mutationOf(this.nodeMutations, nodeId).dirty.add('depends_on');
    }
  }

  private applyTag(
    entityType: 'node' | 'project' | 'artifact',
    entityId: number,
    tag: string,
    note: string | null,
  ): Promise<void> {
    if (entityType === 'artifact') {
      return Promise.reject(
        invariant('artifact tags route through the artifact seam, not the plan'),
      );
    }
    const map = entityType === 'node' ? this.nodeTags : this.projectTags;
    const tags = map.get(entityId) ?? [];
    if (!tags.some((t) => t.tag === tag)) {
      tags.push({ created_at: now(), note, tag });
    }
    map.set(entityId, tags);
    if (entityId > 0) {
      const mutations = entityType === 'node' ? this.nodeMutations : this.projectMutations;
      this.mutationOf(mutations, entityId).dirty.add('tags');
    }
    return Promise.resolve();
  }

  private deleteTags(
    entityType: 'node' | 'project' | 'artifact',
    entityId: number,
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
    if (removed > 0 && entityId > 0) {
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
    // Fail loud on an unresolvable target, mirroring `stemOf`'s contract: a
    // transition against a same-transact create (negative provisional id) or a
    // node/project absent from the snapshot must not be silently dropped —
    // that would lose History. A create is not a transition (ADR 0003), so no
    // legitimate flow reaches here with a non-positive id.
    if (row.node_id != null) {
      if (row.node_id <= 0 || !this.nodes.has(row.node_id)) {
        throw invariant('a transition targets a node absent from the snapshot');
      }
      this.mutationOf(this.nodeMutations, row.node_id).history.push(entry);
    } else if (row.project_id != null) {
      if (row.project_id <= 0 || !this.projects.has(row.project_id)) {
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
   * core-supplied (MMR-173) — the mutation layer stamps it so SQLite and Norn
   * persist the same value — and the record flushes as one `append_to_section`
   * op, the same mechanism `## History` uses. Annotations are node-only; a
   * target absent from the snapshot fails loud rather than silently dropping the
   * note.
   */
  private insertAnnotation(row: NewAnnotationRecord): Promise<void> {
    if (row.node_id <= 0 || !this.nodes.has(row.node_id)) {
      throw invariant('an annotation targets a node absent from the snapshot');
    }
    this.mutationOf(this.nodeMutations, row.node_id).annotations.push({
      content: row.content,
      createdAt: row.created_at,
    });
    return Promise.resolve();
  }

  // ── Plan build (coalesce every effect into one op-set per document) ──────

  /** A node's canonical stem, resolved through its project's key. A create node
   * has no real seq yet — a relation to one is unrepresentable pre-apply. */
  private stemOf(nodeId: number): string {
    const node = this.nodes.get(nodeId);
    if (node === undefined) {
      throw invariant('a relation referenced a node absent from the snapshot');
    }
    if (nodeId < 0) {
      throw invariant('a relation to a node created in the same transact is not yet supported');
    }
    const project = this.projects.get(node.project_id);
    if (project === undefined) {
      throw invariant('a node referenced a project absent from the snapshot');
    }
    return renderId({ key: project.key, seq: node.seq });
  }

  private nodeRelations(node: Node): {
    projectKey: string;
    parentStem: string | null;
    dependsOn: string[];
    tags: NodeTag[];
  } {
    const dependsOn = this.edges
      .filter((e) => e.node_id === node.id)
      .map((e) => this.stemOf(e.depends_on_node_id))
      .toSorted((a, b) => a.localeCompare(b));
    const tags = (this.nodeTags.get(node.id) ?? []).toSorted((a, b) => a.tag.localeCompare(b.tag));
    const project = this.projects.get(node.project_id);
    if (project === undefined) {
      throw invariant('a node referenced a project absent from the snapshot');
    }
    return {
      dependsOn,
      parentStem: node.parent_id === null ? null : this.stemOf(node.parent_id),
      projectKey: project.key,
      tags,
    };
  }

  buildOperations(): MigrationOp[] {
    const operations: MigrationOp[] = [];

    // Creates first, so a mutation's target already exists on disk.
    for (const create of this.creates) {
      if (create.targetKind === 'node') {
        const node = this.nodes.get(create.provisionalId);
        if (node === undefined) {
          throw invariant('a queued node create vanished from the overlay');
        }
        const fm = nodeFrontmatter(node, this.nodeRelations(node));
        operations.push(createDocument(create.pathTemplate, fm, renderNodeBody(node.description)));
      } else {
        const project = this.projects.get(create.provisionalId);
        if (project === undefined) {
          throw invariant('a queued project create vanished from the overlay');
        }
        const tags = (this.projectTags.get(project.id) ?? []).toSorted((a, b) =>
          a.tag.localeCompare(b.tag),
        );
        const fm = projectFrontmatter(project, tags);
        operations.push(createDocument(create.pathTemplate, fm, renderHistoryBody()));
      }
    }

    for (const [id, mutation] of this.nodeMutations) {
      const node = this.nodes.get(id);
      if (node === undefined) {
        throw invariant('a mutated node vanished from the overlay');
      }
      const project = this.projects.get(node.project_id);
      if (project === undefined) {
        throw invariant('a mutated node references a project absent from the snapshot');
      }
      const path = `${project.key}/${renderId({ key: project.key, seq: node.seq })}.md`;
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
      const path = `${project.key}/${project.key}.md`;
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

  /**
   * Replace a created node's provisional echo with the ACTUAL persisted Node,
   * re-resolved from a post-apply reload by its now-real `KEY-seq` stem. The
   * SQLite invariant a create must uphold — a real positive `id` AND `seq`, or
   * the transact throws — holds here too: a stem that never resolved (the
   * report lacked/mismatched its create summary) already threw in
   * {@link extractResolvedSeqs}, and a node missing from the reload throws
   * below. The provisional sentinel is never returned.
   */
  resolveResult<T>(
    result: T,
    resolvedSeqs: Map<Provisional, number>,
    reloaded: NornSnapshot | undefined,
  ): T {
    if (reloaded === undefined || !isRecord(result)) {
      return result;
    }
    const id = result.id;
    if (typeof id !== 'number' || !resolvedSeqs.has(id)) {
      return result;
    }
    const seq = resolvedSeqs.get(id);
    const provisional = this.nodes.get(id);
    const project =
      provisional === undefined ? undefined : this.projects.get(provisional.project_id);
    if (seq === undefined || project === undefined) {
      throw invariant('a created node could not be resolved to its project');
    }
    const stem = renderId({ key: project.key, seq });
    const real = reloaded.workingSet.nodes.find((n) => {
      const p = reloaded.workingSet.projects.find((x) => x.id === n.project_id);
      return p !== undefined && p.key === project.key && n.seq === seq;
    });
    if (real === undefined) {
      throw invariant(`a created node ${stem} was not found in the vault after apply`);
    }
    // Return the real, persisted node — positive `id`, allocated `seq`.
    Object.assign(result, real);
    return result;
  }
}

/**
 * Map each create's provisional id to the sequence Norn allocated. The apply
 * report lists `create_document` ops in plan order — the same order as
 * {@link Accumulator.creates} — each summary carrying the resolved path
 * (`create KEY/KEY-3.md`); parse the node stems back to their seq.
 */
function extractResolvedSeqs(report: unknown, creates: Create[]): Map<Provisional, number> {
  const resolved = new Map<Provisional, number>();
  const operations = reportOperations(report);
  const createSummaries = operations
    .filter((op) => op.kind === 'create_document')
    .map((op) => op.summary);
  creates.forEach((create, index) => {
    if (create.targetKind !== 'node') {
      return;
    }
    // Fail loud rather than leak the negative provisional seq (which would
    // render `KEY--1`): a create MUST resolve its real allocated seq, or the
    // whole transact throws.
    const summary = createSummaries[index];
    if (typeof summary !== 'string') {
      throw invariant('a created node is missing its create summary in the apply report');
    }
    const path = summary.replace(/^create\s+/, '');
    const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const ref = parseId(stem);
    if (ref === null) {
      throw invariant(`a created node's apply-report summary is not a KEY-seq stem: ${summary}`);
    }
    resolved.set(create.provisionalId, ref.seq);
  });
  return resolved;
}

function reportOperations(report: unknown): { kind: string; summary: string }[] {
  const root = isRecord(report) && isRecord(report.report) ? report.report : report;
  if (!isRecord(root) || !Array.isArray(root.operations)) {
    return [];
  }
  return root.operations.flatMap((op) => {
    if (isRecord(op) && typeof op.kind === 'string' && typeof op.summary === 'string') {
      return [{ kind: op.kind, summary: op.summary }];
    }
    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
