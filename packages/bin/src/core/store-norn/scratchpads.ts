import type { Scratchpad } from '@mimir/contract';

import { validation } from '../errors';
import { wikilink } from '../ids';
import {
  decodeScratchpadBody,
  encodeScratchpadBody,
  lintScratchpadValue,
} from '../scratchpads/codec';
import { isScratchpadId } from '../scratchpads/store';
import type { ScratchpadStore } from '../scratchpads/store';
import { isCanonicalInstant } from '../time';
import { applyReportOutcome } from './apply-report';
import type { NornClient } from './client';
import { collapse, isStringRecord } from './decode';
import type { MigrationOp } from './plan';
import {
  addFrontmatter,
  createDocumentPlan,
  deleteDocument,
  migrationPlan,
  removeFrontmatter,
  replaceBody,
  setFrontmatter,
} from './plan';
import { loadWorkingSetOverNorn } from './store';

const pathOf = (id: string): string => `scratch/${id}.md`;

function frontmatterOf(scratchpad: Scratchpad): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    created: scratchpad.createdAt,
    project: wikilink(scratchpad.project),
    title: scratchpad.title,
    type: 'scratch',
    updated_at: scratchpad.updatedAt,
  };
  if (scratchpad.anchors.length > 0) {
    fm.anchor = scratchpad.anchors.map(wikilink);
  }
  if (scratchpad.freezingAt !== null) {
    fm.freezing_at = scratchpad.freezingAt;
  }
  return fm;
}

type ScratchDocument = {
  body: string;
  documentHash: string | null;
  fm: Record<string, unknown>;
  path: string;
};

function rawDocument(value: unknown): ScratchDocument | null {
  if (!isStringRecord(value) || typeof value.path !== 'string') {
    return null;
  }
  if (!isStringRecord(value.frontmatter) || typeof value.body !== 'string') {
    return null;
  }
  return {
    body: value.body,
    documentHash: typeof value.document_hash === 'string' ? value.document_hash : null,
    fm: value.frontmatter,
    path: value.path,
  };
}

export type ScratchpadDocumentDecode = {
  invalidAnchors: string[];
  problems: ScratchpadDocumentProblem[];
  scratchpad: Scratchpad | null;
};

export type ScratchpadDocumentProblem = {
  problem:
    | 'invalid-path'
    | 'invalid-type'
    | 'missing-project'
    | 'invalid-project'
    | 'invalid-title'
    | 'invalid-created'
    | 'invalid-updated-at'
    | 'created-after-updated'
    | 'invalid-freezing-at'
    | 'invalid-body'
    | 'malformed-anchor'
    | 'dangling-anchor'
    | 'cross-project-anchor';
  value?: string;
};

/** Decode one physical scratch document against the canonical work graph.
 * Optional anchors fail independently; every load-bearing field and either
 * owned body section fail closed for the whole record. */
export function decodeScratchpadDocument(
  doc: ScratchDocument,
  validProjects: ReadonlySet<string>,
  anchorProjects: ReadonlyMap<string, string>,
): ScratchpadDocumentDecode {
  const filename = /^scratch\/([^/]+)\.md$/.exec(doc.path);
  const id = filename?.[1];
  const project = collapse(doc.fm.project);
  const title = doc.fm.title;
  const createdAt = doc.fm.created;
  const updatedAt = doc.fm.updated_at;
  const freezingRaw = doc.fm.freezing_at;
  const body = decodeScratchpadBody(doc.body);
  const problems: ScratchpadDocumentProblem[] = [];
  if (id === undefined || !isScratchpadId(id)) {
    problems.push({ problem: 'invalid-path' });
  }
  if (doc.fm.type !== 'scratch') {
    problems.push({ problem: 'invalid-type' });
  }
  if (project === null) {
    problems.push({ problem: 'missing-project' });
  } else if (!validProjects.has(project)) {
    problems.push({ problem: 'invalid-project', value: project });
  }
  if (typeof title !== 'string' || title.trim() === '') {
    problems.push({ problem: 'invalid-title' });
  }
  // Timestamps stay STRICT on the read path (MMR-351): a merely-normalizable
  // stored instant (an offset form, a missing millisecond) fails closed here
  // rather than being coerced, so the pad stays unreadable until `doctor`
  // rewrites the document. Repairability is classified once, at detection.
  if (!isCanonicalInstant(createdAt)) {
    problems.push({ problem: 'invalid-created' });
  }
  if (!isCanonicalInstant(updatedAt)) {
    problems.push({ problem: 'invalid-updated-at' });
  }
  if (isCanonicalInstant(createdAt) && isCanonicalInstant(updatedAt) && createdAt > updatedAt) {
    problems.push({ problem: 'created-after-updated' });
  }
  if (freezingRaw !== undefined && freezingRaw !== null && !isCanonicalInstant(freezingRaw)) {
    problems.push({ problem: 'invalid-freezing-at' });
  }
  if (body.value === null) {
    problems.push({ problem: 'invalid-body' });
  }
  if (
    problems.length > 0 ||
    id === undefined ||
    project === null ||
    typeof title !== 'string' ||
    !isCanonicalInstant(createdAt) ||
    !isCanonicalInstant(updatedAt) ||
    body.value === null
  ) {
    return { invalidAnchors: [], problems, scratchpad: null };
  }
  let rawAnchors: unknown[] = [];
  if (Array.isArray(doc.fm.anchor)) {
    rawAnchors = doc.fm.anchor;
  } else if (doc.fm.anchor !== undefined) {
    rawAnchors = [doc.fm.anchor];
  }
  const requestedAnchors: string[] = [];
  for (const rawAnchor of rawAnchors) {
    const anchor = collapse(rawAnchor);
    if (anchor === null) {
      problems.push({ problem: 'malformed-anchor', value: String(rawAnchor) });
    } else {
      requestedAnchors.push(anchor);
    }
  }
  const anchors = requestedAnchors.filter((anchor) => anchorProjects.get(anchor) === project);
  const invalidAnchors = requestedAnchors.filter(
    (anchor) => anchorProjects.get(anchor) !== project,
  );
  problems.push(
    ...invalidAnchors.map((value) => ({
      problem: anchorProjects.has(value)
        ? ('cross-project-anchor' as const)
        : ('dangling-anchor' as const),
      value,
    })),
  );
  return {
    invalidAnchors,
    problems,
    scratchpad: {
      ...body.value,
      anchors,
      createdAt,
      freezingAt: typeof freezingRaw === 'string' ? freezingRaw : null,
      id,
      project,
      title,
      updatedAt,
    },
  };
}

export function createNornScratchpadStore(client: NornClient, vaultRoot: string): ScratchpadStore {
  const graph = async (): Promise<{ projects: Set<string>; anchors: Map<string, string> }> => {
    const working = await loadWorkingSetOverNorn(client);
    return {
      anchors: new Map(working.nodes.map((node) => [node.id, node.project_id])),
      projects: new Set(working.projects.map((project) => project.key)),
    };
  };

  const getRaw = async (id: string): Promise<ScratchDocument | undefined> => {
    if (!isScratchpadId(id)) {
      return undefined;
    }
    const records = await client.get([pathOf(id)], '.frontmatter,.body,.document_hash');
    return rawDocument(records[0]) ?? undefined;
  };

  const decode = async (doc: ScratchDocument): Promise<Scratchpad | undefined> => {
    const valid = await graph();
    return decodeScratchpadDocument(doc, valid.projects, valid.anchors).scratchpad ?? undefined;
  };

  const apply = async (operations: MigrationOp[]): Promise<void> => {
    const outcome = applyReportOutcome(
      await client.applyPlan(migrationPlan({ generator: 'mimir', operations, vaultRoot }), true),
    );
    if (outcome !== 'applied') {
      throw validation(
        'the scratchpad write did not complete',
        `apply outcome: ${outcome ?? 'unrecognized'}`,
      );
    }
  };

  return {
    async create(scratchpad) {
      if (lintScratchpadValue(scratchpad).length > 0) {
        throw validation('the scratchpad Agenda state is not valid for persistence');
      }
      const valid = await graph();
      const decoded = decodeScratchpadDocument(
        {
          body: encodeScratchpadBody(scratchpad),
          documentHash: null,
          fm: frontmatterOf(scratchpad),
          path: pathOf(scratchpad.id),
        },
        valid.projects,
        valid.anchors,
      );
      if (decoded.scratchpad === null || decoded.invalidAnchors.length > 0) {
        throw validation('the scratchpad is not valid for persistence');
      }
      const plan = createDocumentPlan(
        vaultRoot,
        pathOf(scratchpad.id),
        frontmatterOf(scratchpad),
        encodeScratchpadBody(scratchpad),
      );
      const outcome = applyReportOutcome(await client.applyPlan(plan, true));
      if (outcome !== 'applied') {
        throw validation(
          'the scratchpad create did not complete',
          `apply outcome: ${outcome ?? 'unrecognized'}`,
        );
      }
    },

    async delete(id, expectedUpdatedAt) {
      const doc = await getRaw(id);
      if (doc === undefined) {
        return;
      }
      const current = await decode(doc);
      if (current === undefined) {
        throw validation(
          `${id} names a quarantined scratchpad`,
          'inspect and recover the raw document before retrying the delete',
        );
      }
      if (current.updatedAt !== expectedUpdatedAt) {
        throw validation('the scratchpad changed concurrently', 'reload it and retry the mutation');
      }
      if (doc.documentHash === null) {
        throw validation(`${doc.path} carries no document hash for the delete guard`);
      }
      await apply([deleteDocument(doc.path, doc.documentHash)]);
    },

    async list(project) {
      const eq = ['type:scratch'];
      if (project !== undefined) {
        eq.push(`project:${project}`);
      }
      const docs = await client.find({
        col: ['.frontmatter', '.body', '.document_hash'],
        eq,
        no_limit: true,
      });
      const valid = await graph();
      return docs
        .map(rawDocument)
        .filter((doc): doc is ScratchDocument => doc !== null)
        .map((doc) => decodeScratchpadDocument(doc, valid.projects, valid.anchors).scratchpad)
        .filter((pad): pad is Scratchpad => pad !== null)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    },

    async load(id) {
      const doc = await getRaw(id);
      return doc === undefined ? undefined : decode(doc);
    },

    async replace(scratchpad, expectedUpdatedAt) {
      const doc = await getRaw(scratchpad.id);
      const current = doc === undefined ? undefined : await decode(doc);
      if (doc === undefined || current === undefined) {
        throw validation(`${scratchpad.id} does not name a readable scratchpad`);
      }
      if (current.updatedAt !== expectedUpdatedAt) {
        throw validation('the scratchpad changed concurrently', 'reload it and retry the mutation');
      }
      if (scratchpad.updatedAt <= current.updatedAt) {
        throw validation('the scratchpad updatedAt must advance on replacement');
      }
      if (lintScratchpadValue(scratchpad).length > 0) {
        throw validation('the scratchpad Agenda state is not valid for persistence');
      }
      if (scratchpad.project !== current.project || scratchpad.createdAt !== current.createdAt) {
        throw validation('scratchpad project and createdAt are immutable');
      }
      const valid = await graph();
      const candidate = decodeScratchpadDocument(
        {
          body: encodeScratchpadBody(scratchpad),
          documentHash: doc.documentHash,
          fm: frontmatterOf(scratchpad),
          path: doc.path,
        },
        valid.projects,
        valid.anchors,
      );
      if (candidate.scratchpad === null || candidate.invalidAnchors.length > 0) {
        throw validation('the scratchpad replacement is not valid for persistence');
      }
      if (doc.documentHash === null) {
        throw validation(`${doc.path} carries no document hash for the write guard`);
      }
      const next = frontmatterOf(scratchpad);
      const operations: MigrationOp[] = [
        replaceBody(doc.path, doc.documentHash, encodeScratchpadBody(scratchpad)),
      ];
      for (const field of ['title', 'anchor', 'freezing_at'] as const) {
        if (!(field in next)) {
          if (field in doc.fm) {
            operations.push(removeFrontmatter(doc.path, field, doc.fm[field]));
          }
        } else if (field in doc.fm) {
          operations.push(setFrontmatter(doc.path, field, next[field], doc.fm[field]));
        } else {
          operations.push(addFrontmatter(doc.path, field, next[field]));
        }
      }
      operations.push(
        setFrontmatter(doc.path, 'updated_at', scratchpad.updatedAt, doc.fm.updated_at),
      );
      await apply(operations);
    },
  };
}
