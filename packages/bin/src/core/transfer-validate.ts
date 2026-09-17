import { isDeepStrictEqual } from 'node:util';

import { FIELD_FACTS } from '@mimir/contract';

import { validation } from './errors';
import type { StoreExport } from './export';
import { STORE_EXPORT_SCHEMA_VERSION } from './export';
import { isSeedRef, parseId, renderId, renderArtifactRef, renderSeedRef } from './ids';
import {
  lintScratchpadValue,
  decodeScratchpadBody,
  encodeScratchpadBody,
} from './scratchpads/codec';
import { isCanonicalInstant } from './time';
import { transferSchema } from './transfer-schema';
import { validate } from './validate';

/**
 * Transfer-document validation shared by every backend's import (ADR 0030
 * Decision 4). The document is backend-neutral, so the faults it can carry are
 * backend-neutral too — one implementation, or two backends would disagree
 * about which documents are importable.
 */

/** How many offending identities a refusal names before it stops. */
export const REFUSAL_SAMPLE = 20;

/** The first {@link REFUSAL_SAMPLE} names, with a count of whatever is left —
 * a refusal must be actionable without printing a whole vault. */
export function namedSample(names: readonly string[]): string {
  const shown = names.slice(0, REFUSAL_SAMPLE).join(', ');
  const rest = names.length - REFUSAL_SAMPLE;
  return rest > 0 ? `${shown} (and ${String(rest)} more)` : shown;
}

/**
 * Refuse a transfer document whose collections claim one identity twice, BEFORE
 * anything is written (the fence a fresh import already sets for projects,
 * widened to every identity kind).
 *
 * An identity is a single record's whole claim on the target — a canonical path
 * on Norn, a primary key on Postgres — so two records claiming it are two
 * documents competing for one place. The import would write one and then refuse
 * on the other, leaving the target half-written for a fault that was visible in
 * the document all along. A fail-closed export cannot PRODUCE such a document —
 * it refuses on the source collision first — but an import reads whatever it is
 * handed, including a hand-edited or foreign-backend document.
 */
export function assertSingleValuedIdentities(document: StoreExport): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const claim = (identity: string): void => {
    if (seen.has(identity)) {
      duplicates.push(identity);
      return;
    }
    seen.add(identity);
  };
  for (const project of document.projects) {
    claim(`project ${project.key}`);
  }
  for (const node of document.nodes) {
    claim(`node ${node.id}`);
  }
  for (const artifact of document.artifacts) {
    claim(`artifact ${renderArtifactRef(artifact)}`);
  }
  for (const seed of document.seeds) {
    claim(`seed ${renderSeedRef(seed)}`);
  }
  for (const pad of document.scratchpads) {
    claim(`scratchpad ${pad.id}`);
  }
  if (duplicates.length > 0) {
    throw validation(
      `the transfer document claims one identity twice: ${namedSample(duplicates)}`,
      'every identity is a canonical path, so two records claiming one would half-write the target — repair the document before importing it',
    );
  }
}

/** Parse once at each Store import boundary, before target access or writes. */
export function parseTransferDocument(input: unknown): StoreExport {
  if (
    typeof input === 'object' &&
    input !== null &&
    'schema_version' in input &&
    input.schema_version !== STORE_EXPORT_SCHEMA_VERSION
  ) {
    throw validation(
      `unsupported transfer document schema version ${String(input.schema_version)}`,
      `this binary reads schema version ${String(STORE_EXPORT_SCHEMA_VERSION)}`,
    );
  }
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) {
    throw validation(
      `invalid transfer document: ${namedSample(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`))}`,
      'repair the document before importing it',
    );
  }
  const document = parsed.data;
  assertSingleValuedIdentities(document);
  assertReferences(document);
  assertAcyclic(document);
  return document;
}

/** Relations resolve in the complete document, including on resume. */
function assertReferences(document: StoreExport): void {
  const projects = new Set(document.projects.map((project) => project.key));
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const faults: string[] = [];
  const projectRef = (key: string, field: string): void => {
    if (!projects.has(key)) {
      faults.push(`${field} references missing project ${key}`);
    }
  };
  const nodeRef = (id: string, field: string, project?: string): void => {
    const node = nodes.get(id);
    if (node === undefined) {
      faults.push(`${field} references missing node ${id}`);
    } else if (project !== undefined && node.project_id !== project) {
      faults.push(`${field} references node ${id} outside project ${project}`);
    }
  };
  for (const node of document.nodes) {
    const identity = parseId(node.id);
    if (identity === null || node.id !== renderId({ key: node.project_id, seq: node.seq })) {
      faults.push(`node ${node.id} identity disagrees with project_id or seq`);
    }
    for (const field of Object.values(FIELD_FACTS)) {
      const applies = field.appliesTo.some((type) => type === node.type);
      if (!applies && node[field.key] !== null) {
        faults.push(`node ${node.id}.${field.key} does not apply to ${node.type}`);
      }
      if (applies && 'required' in field && field.required && node[field.key] === null) {
        faults.push(`node ${node.id}.${field.key} is required`);
      }
    }
    if (node.type === 'task' && node.hold === null) {
      faults.push(`node ${node.id}.hold is required`);
    }
    if (node.upstream !== null && !isSeedRef(node.upstream)) {
      faults.push(`node ${node.id}.upstream must be a seed identity`);
    }
    if (node.description !== null) {
      faults.push(`node ${node.id}.description belongs in bodySections`);
    }
    if (node.type !== 'task' && (node.rank !== null || node.completed_at !== null)) {
      faults.push(`node ${node.id} rank and completed_at apply only to tasks`);
    }
    projectRef(node.project_id, `node ${node.id}.project_id`);
    if (node.parent_id !== null) {
      nodeRef(node.parent_id, `node ${node.id}.parent_id`, node.project_id);
    }
  }
  for (const edge of document.edges) {
    nodeRef(edge.node_id, 'edge.node_id');
    nodeRef(edge.depends_on_node_id, `edge ${edge.node_id}.depends_on_node_id`);
    if (edge.node_id === edge.depends_on_node_id) {
      faults.push(`edge ${edge.node_id} depends on itself`);
    }
  }
  for (const row of document.annotations) {
    nodeRef(row.node_id, 'annotation.node_id');
  }
  for (const artifact of document.artifacts) {
    const id = renderArtifactRef(artifact);
    projectRef(artifact.key, `artifact ${id}.key`);
    for (const link of artifact.links) {
      nodeRef(link, `artifact ${id}.links`, artifact.key);
    }
  }
  for (const seed of document.seeds) {
    const id = renderSeedRef(seed);
    projectRef(seed.key, `seed ${id}.key`);
    for (const spawned of seed.spawned) {
      nodeRef(spawned, `seed ${id}.spawned`);
    }
  }
  for (const pad of document.scratchpads) {
    for (const field of ['createdAt', 'updatedAt', 'freezingAt'] as const) {
      const value = pad[field];
      if (value !== null && !isCanonicalInstant(value)) {
        faults.push(`scratchpad ${pad.id}.${field} must be a canonical instant`);
      }
    }
    if (pad.createdAt > pad.updatedAt) {
      faults.push(`scratchpad ${pad.id}.createdAt is after updatedAt`);
    }
    if (pad.title.trim() === '') {
      faults.push(`scratchpad ${pad.id}.title is blank`);
    }
    for (const problem of lintScratchpadValue(pad)) {
      faults.push(`scratchpad ${pad.id}: ${problem}`);
    }
    const body = decodeScratchpadBody(encodeScratchpadBody(pad));
    for (const problem of body.problems) {
      faults.push(`scratchpad ${pad.id}: ${problem.problem}`);
    }
    if (
      body.value !== null &&
      !isDeepStrictEqual(body.value, { agenda: pad.agenda, journal: pad.journal })
    ) {
      faults.push(`scratchpad ${pad.id}.body cannot preserve the supplied journal or agenda`);
    }
    projectRef(pad.project, `scratchpad ${pad.id}.project`);
    for (const anchor of pad.anchors) {
      nodeRef(anchor, `scratchpad ${pad.id}.anchors`, pad.project);
    }
  }
  for (const row of document.tags) {
    if (row.entity_type === 'node') {
      nodeRef(row.entity_id, 'tag.entity_id');
    } else if (row.entity_type === 'project') {
      projectRef(row.entity_id, 'tag.entity_id');
    } else {
      faults.push(
        `tag ${row.entity_id}.entity_type must be node or project; artifact tags belong on the artifact`,
      );
    }
  }
  const sections = new Set<string>();
  for (const row of document.bodySections) {
    if (!projects.has(row.stem) && !nodes.has(row.stem)) {
      faults.push(`bodySections.stem references missing entity ${row.stem}`);
    }
    if (sections.has(row.stem)) {
      faults.push(`bodySections claims ${row.stem} twice`);
    }
    sections.add(row.stem);
    if (projects.has(row.stem) && row.description != null) {
      faults.push(`bodySections ${row.stem}.description belongs on the project`);
    }
    if (!row.next.present && row.next.text !== null) {
      faults.push(`bodySections ${row.stem}.next has text without a section`);
    }
  }
  for (const row of document.transitions) {
    if ((row.node_id == null) === (row.project_id == null)) {
      faults.push('transition must have exactly one node_id or project_id');
    } else if (row.node_id != null) {
      nodeRef(row.node_id, 'transition.node_id');
    } else if (row.project_id != null) {
      projectRef(row.project_id, 'transition.project_id');
    }
  }
  if (faults.length > 0) {
    throw validation(
      `invalid transfer document: ${namedSample(faults)}`,
      'repair the document before importing it',
    );
  }
}

/** Use the reader's graph rules, but refuse instead of dropping cycle edges. */
function assertAcyclic(document: StoreExport): void {
  const dependencies = new Map<string, string[]>();
  for (const edge of document.edges) {
    const targets = dependencies.get(edge.node_id);
    if (targets === undefined) {
      dependencies.set(edge.node_id, [edge.depends_on_node_id]);
    } else {
      targets.push(edge.depends_on_node_id);
    }
  }
  const graph = validate({
    nodes: document.nodes.map((node) => ({
      dependsOn: dependencies.get(node.id) ?? [],
      key: node.project_id,
      parent: node.parent_id,
      stem: node.id,
    })),
    projectKeys: document.projects.map((project) => project.key),
  });
  const cycles = graph.dropped.filter(
    (drop) => drop.rule === 'cycle-parent' || drop.rule === 'cycle-depends-on',
  );
  if (cycles.length > 0) {
    throw validation(
      `invalid transfer document: ${namedSample(cycles.map((drop) => `${drop.stem}: ${drop.rule}`))}`,
      'remove the cyclic references before importing it',
    );
  }
}
