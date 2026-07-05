import type {
  ArtifactDetail,
  ArtifactView,
  AwaitingRef,
  DepsFacet,
  FacetName,
  NodeRef,
  NodeView,
  TagView,
} from '@mimir/contract';

import type { ArtifactRecord, ArtifactStore } from '../artifacts/store';
import { attentionOf } from '../attention';
import type { BodySectionStore } from '../body-sections/store';
import type { DerivationSet } from '../derive';
import {
  childDistribution,
  deriveSet,
  findProjectInSet,
  isNodeSettled,
  leafDistribution,
  lineageIds,
  nodeStatusWord,
  renderNodeIdFromSet,
  rootDistribution,
} from '../derive';
import { renderArtifactRef } from '../ids';
import type { Node, Project } from '../model';
import { verdictsOf } from '../predicates';
import { interpret } from '../status';
import type { Store } from '../store';

/**
 * Projection assembly — build a {@link NodeView} from a node row plus the
 * requested facets. Bare fields are always populated (the row is in hand);
 * task-only / phase-only fields appear only for that type. Derivation-backed
 * facets (status, distribution, deps, verdicts, children, node and project tags)
 * serve from the working-set snapshot (ADR 0016 Phase 0/2b); artifacts route
 * through the artifact seam; the body-section facets (annotations, history)
 * read through the {@link BodySectionStore} seam (MMR-154).
 */

function toRef(set: DerivationSet, nodeId: number): NodeRef {
  const node = set.nodeById.get(nodeId);
  if (node === undefined) {
    return { id: 'unknown' };
  }
  return {
    id: renderNodeIdFromSet(set, node) ?? 'unknown',
    status: nodeStatusWord(set, node),
    title: node.title,
  };
}

export async function buildNodeView(
  bodySections: BodySectionStore,
  artifacts: ArtifactStore,
  set: DerivationSet,
  node: Node,
  facets: ReadonlySet<FacetName> = new Set(),
): Promise<NodeView> {
  const parent = node.parent_id === null ? undefined : set.nodeById.get(node.parent_id);
  const view: NodeView = {
    createdAt: node.created_at,
    id: renderNodeIdFromSet(set, node) ?? 'unknown',
    parent: parent === undefined ? null : renderNodeIdFromSet(set, parent),
    status: nodeStatusWord(set, node),
    summary: node.summary,
    title: node.title,
    type: node.type,
    updatedAt: node.updated_at,
  };

  if (node.type === 'task') {
    view.priority = node.priority;
    view.size = node.size;
    view.lifecycle = node.lifecycle ?? undefined;
    view.hold = node.hold ?? undefined;
    view.holdReason = node.hold_reason;
    view.externalRef = node.external_ref;
    view.completedAt = node.completed_at;
  } else if (node.type === 'phase') {
    view.target = node.target;
  }

  if (facets.has('deps')) {
    view.deps = buildDeps(set, node.id);
  }
  if (facets.has('children')) {
    view.children = buildChildren(set, node.id);
  }
  if (facets.has('distribution') && node.type !== 'task') {
    view.distribution = childDistribution(set, node.id);
  }
  if (facets.has('tags')) {
    view.tags = buildTags(set, node.id);
  }
  // The three body-section facets read one node document — fetch its body once
  // and slice all requested sections in a single backend round-trip (MMR-164, F6).
  const wantDescription = facets.has('description');
  const wantAnnotations = facets.has('annotations');
  const wantHistory = facets.has('history');
  if (wantDescription || wantAnnotations || wantHistory) {
    const sections = await bodySections.readSections(node.id, view.id, {
      annotations: wantAnnotations,
      description: wantDescription,
      history: wantHistory,
    });
    if (wantDescription) {
      view.description = sections.description ?? null;
    }
    if (wantAnnotations) {
      view.annotations = sections.annotations ?? [];
    }
    if (wantHistory) {
      view.history = sections.history ?? [];
    }
  }
  if (facets.has('artifacts')) {
    view.artifacts = await buildArtifacts(artifacts, set, node.id);
  }
  if (facets.has('verdicts')) {
    view.verdicts = verdictsOf(set, node);
  }
  return view;
}

/**
 * Refs for a set of linked node ids, dropping any whose owning project is
 * archived — a cross-project edge must not leak an archived node's id/title/
 * status through the `deps` facet (ADR 0015; the facet is a read side-door that
 * bypasses the id-level not_found guards).
 */
function visibleRefs(set: DerivationSet, nodeIds: readonly number[]): NodeRef[] {
  const refs: NodeRef[] = [];
  for (const id of nodeIds) {
    const node = set.nodeById.get(id);
    if (node !== undefined && set.archivedProjects.has(node.project_id)) {
      continue;
    }
    refs.push(toRef(set, id));
  }
  return refs;
}

function buildDeps(set: DerivationSet, nodeId: number): DepsFacet {
  return {
    awaitingOn: buildAwaitingOn(set, nodeId),
    blocking: visibleRefs(set, set.dependentsByNode.get(nodeId) ?? []),
    dependsOn: visibleRefs(set, set.prereqsByNode.get(nodeId) ?? []),
  };
}

/**
 * The still-unsettled **effective** prerequisites gating this node — its own
 * edges and any inherited from an ancestor — each tagged with the ancestor it
 * came `via` when inherited. The self-orienting answer to "what unblocks me?"
 * (ADR 0001 Refinement). Only unsettled prereqs appear; settled ones no longer
 * gate.
 */
function buildAwaitingOn(set: DerivationSet, nodeId: number): AwaitingRef[] {
  const out: AwaitingRef[] = [];
  const seen = new Set<number>();
  // lineage is node-first, so a prereq reached both directly and via an ancestor
  // keeps its direct (no-`via`) entry — list each unsettled prerequisite once.
  for (const ancestorId of lineageIds(set, nodeId)) {
    for (const prereqId of set.prereqsByNode.get(ancestorId) ?? []) {
      if (seen.has(prereqId)) {
        continue;
      }
      const prereq = set.nodeById.get(prereqId);
      if (prereq === undefined || isNodeSettled(set, prereq)) {
        continue;
      }
      // A prereq in an archived project reads as absent — don't surface it (ADR 0015).
      if (set.archivedProjects.has(prereq.project_id)) {
        continue;
      }
      seen.add(prereqId);
      const ref: AwaitingRef = toRef(set, prereqId);
      if (ancestorId !== nodeId) {
        const ancestor = set.nodeById.get(ancestorId);
        ref.via =
          ancestor === undefined ? undefined : (renderNodeIdFromSet(set, ancestor) ?? undefined);
      }
      out.push(ref);
    }
  }
  return out;
}

const bySeq = (a: Node, b: Node): number => a.seq - b.seq;

function buildChildren(set: DerivationSet, nodeId: number): NodeRef[] {
  const children = (set.childrenByParent.get(nodeId) ?? []).toSorted(bySeq);
  return children.map((child) => toRef(set, child.id));
}

function buildTags(set: DerivationSet, nodeId: number): TagView[] {
  const records = set.ws.nodeTags.get(nodeId) ?? [];
  return records.map((r) => ({ createdAt: r.created_at, note: r.note, tag: r.tag }));
}

/** Map a seam record to the metadata-only `artifacts` facet view. */
function toArtifactView(record: ArtifactRecord): ArtifactView {
  return {
    createdAt: record.created_at,
    id: renderArtifactRef({ key: record.key, seq: record.seq }),
    tags: record.tags,
    title: record.title,
  };
}

async function buildArtifacts(
  artifacts: ArtifactStore,
  set: DerivationSet,
  nodeId: number,
): Promise<ArtifactView[]> {
  const node = set.nodeById.get(nodeId);
  const stem = node === undefined ? undefined : renderNodeIdFromSet(set, node);
  if (stem === undefined || stem === null) {
    return [];
  }
  const records = await artifacts.listForNode(stem);
  return records.map(toArtifactView);
}

/** All of a project's artifacts — the inventory behind `get KEY --col artifacts` (MMR-32/34). */
async function buildProjectArtifacts(
  artifacts: ArtifactStore,
  project: Project,
): Promise<ArtifactView[]> {
  const records = await artifacts.listForProject(project.key);
  return records.map(toArtifactView);
}

/**
 * The whole-project view (`get KEY`, MMR-32) — the project rendered through the
 * same projection contract as a node: `type: "project"`, status = `interpret`
 * over its root nodes. Facets that don't apply to a project (deps,
 * annotations, history) are silently absent.
 */
export async function buildProjectView(
  artifacts: ArtifactStore,
  set: DerivationSet,
  project: Project,
  facets: ReadonlySet<FacetName> = new Set(),
): Promise<NodeView> {
  const distribution = rootDistribution(set, project.id);
  const view: NodeView = {
    createdAt: project.created_at,
    description: project.description,
    id: project.key,
    parent: null,
    status: interpret(distribution),
    title: project.name,
    type: 'project',
    updatedAt: project.updated_at,
  };
  // The archived axis (ADR 0015) — non-null only when archived; the wire omits it otherwise.
  if (project.archived_at !== null) {
    view.archivedAt = project.archived_at;
  }
  if (facets.has('children')) {
    const roots = (set.nodesByProject.get(project.id) ?? [])
      .filter((n) => n.parent_id === null)
      .toSorted(bySeq);
    view.children = roots.map((root) => toRef(set, root.id));
  }
  if (facets.has('distribution')) {
    view.distribution = distribution;
  }
  if (facets.has('leafCounts')) {
    view.leafCounts = leafDistribution(set, project.id);
  }
  if (facets.has('attention')) {
    view.attention = attentionOf(set, project);
  }
  if (facets.has('tags')) {
    const records = set.ws.projectTags.get(project.id) ?? [];
    view.tags = records.map((r) => ({ createdAt: r.created_at, note: r.note, tag: r.tag }));
  }
  if (facets.has('artifacts')) {
    view.artifacts = await buildProjectArtifacts(artifacts, project);
  }
  return view;
}

/**
 * A standalone artifact record (`get KEY-aN`, MMR-32/34) — metadata + linked
 * nodes + tags; the frozen body only when opted in (`--col content`). The seam
 * record already carries links (node stems) and tags, so this is a pure map
 * (MMR-143).
 */
export function buildArtifactDetail(record: ArtifactRecord & { content?: string }): ArtifactDetail {
  const detail: ArtifactDetail = {
    createdAt: record.created_at,
    id: renderArtifactRef({ key: record.key, seq: record.seq }),
    links: record.links,
    project: record.key,
    tags: record.tags,
    title: record.title,
  };
  if (record.content !== undefined) {
    detail.content = record.content;
  }
  return detail;
}

/** A node view over a fresh snapshot — the one-off echo path (verbs, transports). */
export async function nodeViewOf(
  store: Store,
  node: Node,
  facets: ReadonlySet<FacetName> = new Set(),
): Promise<NodeView> {
  return buildNodeView(
    store.bodySections,
    store.artifacts,
    deriveSet(await store.loadWorkingSet()),
    node,
    facets,
  );
}

/**
 * A node view resolved by surrogate id over a fresh snapshot (MMR-160) — the
 * write-echo path when the caller holds only the id (the verb was invoked for
 * effect, not its return). Loads the working set once, finds the node in it,
 * and derives — no raw db read. `undefined` if the id is absent from the set.
 */
export async function nodeViewById(
  store: Store,
  id: number,
  facets: ReadonlySet<FacetName> = new Set(),
): Promise<NodeView | undefined> {
  const set = deriveSet(await store.loadWorkingSet());
  const node = set.nodeById.get(id);
  return node === undefined
    ? undefined
    : buildNodeView(store.bodySections, store.artifacts, set, node, facets);
}

/** A project view resolved by `KEY` over a fresh snapshot (MMR-160) — the
 * project write-echo path; `undefined` if no project has that key. */
export async function projectViewByKey(
  store: Store,
  key: string,
  facets: ReadonlySet<FacetName> = new Set(),
): Promise<NodeView | undefined> {
  const set = deriveSet(await store.loadWorkingSet());
  const project = findProjectInSet(set, key);
  return project === undefined
    ? undefined
    : buildProjectView(store.artifacts, set, project, facets);
}

/** A project view over a fresh snapshot — the one-off echo path (verbs, transports). */
export async function projectViewOf(
  store: Store,
  project: Project,
  facets: ReadonlySet<FacetName> = new Set(),
): Promise<NodeView> {
  return buildProjectView(
    store.artifacts,
    deriveSet(await store.loadWorkingSet()),
    project,
    facets,
  );
}
