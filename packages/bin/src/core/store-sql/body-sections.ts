import type { AnnotationView, HistoryEntry } from '@mimir/contract';

import type { BodySections, BodySectionStore, NextFacet } from '../body-sections/store';
import { inLists } from './batch';
import type { StoreDialect } from './dialect';
import type { Executor, Stored } from './schema';

/**
 * The SQL store's body-section slice. The output contract's prose and log
 * sections — `## Task Description`, `## Next`, `## Annotations`, `## History` —
 * are columns and rows here, so this module is the projection back onto the
 * seam's facet shapes.
 *
 * `readSectionsMany` is a BATCH by construction: one query per requested facet
 * over the whole stem list, never one round trip per stem — a per-stem loop
 * would be N queries where one `WHERE id IN (...)` does.
 */

/** A stored prose column as the seam yields it: trimmed, blank reads as none. */
function prose(value: string | null): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

/** The prose columns a node and a project share. */
type OwnerRow = {
  description: string | null;
  next_present: Stored<boolean>;
  next_text: string | null;
};

/** The `## Next` facet from its two columns — presence is its own stored fact. */
function nextFacet(row: OwnerRow, dialect: StoreDialect): NextFacet {
  return { present: dialect.codecs.bool.decode(row.next_present), text: prose(row.next_text) };
}

/** Which of the requested stems name a node, and which a project. */
type Owners = {
  nodes: Map<string, OwnerRow>;
  projects: Map<string, OwnerRow>;
};

async function resolveOwners(
  ex: Executor,
  dialect: StoreDialect,
  stems: readonly string[],
): Promise<Owners> {
  const owners: Owners = { nodes: new Map(), projects: new Map() };
  for (const chunk of inLists(stems, dialect.maxParameters)) {
    const nodeRows = await ex
      .selectFrom('node')
      .select(['id', 'description', 'next_present', 'next_text'])
      .where('id', 'in', chunk)
      .execute();
    const projectRows = await ex
      .selectFrom('project')
      .select(['key', 'description', 'next_present', 'next_text'])
      .where('key', 'in', chunk)
      .execute();
    for (const row of nodeRows) {
      owners.nodes.set(row.id, row);
    }
    for (const row of projectRows) {
      owners.projects.set(row.key, row);
    }
  }
  return owners;
}

/** The `## Annotations` rows of many nodes, keyed by stem, in append order. */
async function annotationsByStem(
  ex: Executor,
  dialect: StoreDialect,
  stems: readonly string[],
): Promise<Map<string, AnnotationView[]>> {
  const out = new Map<string, AnnotationView[]>();
  // A stem's rows all land in its one chunk, so the per-stem order holds.
  for (const chunk of inLists(stems, dialect.maxParameters)) {
    await annotationsInto(out, ex, chunk);
  }
  return out;
}

async function annotationsInto(
  out: Map<string, AnnotationView[]>,
  ex: Executor,
  stems: string[],
): Promise<void> {
  const rows = await ex
    .selectFrom('annotation')
    .select(['node_id', 'content', 'created_at'])
    .where('node_id', 'in', stems)
    // Insert order, NOT timestamp order (MMR-380). A node's `## Annotations`
    // order is the stored fact, the same reasoning `canonicalTransitionOrder`
    // spells out: an imported node whose notes are not timestamp-monotonic
    // (hand-edited, backfilled, clock-skewed) would otherwise re-export in a
    // different order than it was imported in, and then refuse its own resume.
    .orderBy('id')
    .execute();
  for (const row of rows) {
    const view: AnnotationView = { content: row.content, createdAt: row.created_at };
    out.set(row.node_id, [...(out.get(row.node_id) ?? []), view]);
  }
}

/** The `## History` rows of many nodes and projects, keyed by stem, in log order. */
async function historyByStem(
  ex: Executor,
  dialect: StoreDialect,
  stems: readonly string[],
): Promise<Map<string, HistoryEntry[]>> {
  const out = new Map<string, HistoryEntry[]>();
  // Two parameters per stem: it is matched against both owner columns.
  for (const chunk of inLists(stems, dialect.maxParameters, 2)) {
    await historyInto(out, ex, dialect, chunk);
  }
  return out;
}

async function historyInto(
  out: Map<string, HistoryEntry[]>,
  ex: Executor,
  dialect: StoreDialect,
  stems: string[],
): Promise<void> {
  const rows = await ex
    .selectFrom('transition_log')
    .selectAll()
    .where((eb) => eb.or([eb('node_id', 'in', stems), eb('project_key', 'in', stems)]))
    .orderBy('id')
    .execute();
  for (const row of rows) {
    const stem = row.node_id ?? row.project_key;
    if (stem === null) {
      continue;
    }
    const entry: HistoryEntry = {
      at: row.at,
      from: row.from_value,
      kind: row.kind,
      reason: row.reason,
      to: row.to_value,
    };
    // The resume-handle echo (ADR 0026 Decision 3) rides only the boundary rows
    // that moved handles, so a non-boundary row carries no key at all.
    if (row.handles !== null) {
      entry.handles = dialect.codecs.json.decode(row.handles);
    }
    out.set(stem, [...(out.get(stem) ?? []), entry]);
  }
}

export function createSqlBodySectionStore(ex: Executor, dialect: StoreDialect): BodySectionStore {
  const readSectionsMany: BodySectionStore['readSectionsMany'] = async (stems, want) => {
    const out = new Map<string, BodySections>();
    const unique = [...new Set(stems)];
    if (unique.length === 0) {
      return out;
    }
    const owners = await resolveOwners(ex, dialect, unique);
    const present = unique.filter((stem) => owners.nodes.has(stem) || owners.projects.has(stem));
    const annotations =
      want.annotations === true
        ? await annotationsByStem(
            ex,
            dialect,
            present.filter((stem) => owners.nodes.has(stem)),
          )
        : new Map<string, AnnotationView[]>();
    const history =
      want.history === true
        ? await historyByStem(ex, dialect, present)
        : new Map<string, HistoryEntry[]>();
    for (const stem of present) {
      const row = owners.nodes.get(stem) ?? owners.projects.get(stem);
      if (row === undefined) {
        continue;
      }
      const sections: BodySections = {};
      if (want.description === true) {
        sections.description = prose(row.description);
      }
      if (want.next === true) {
        sections.next = nextFacet(row, dialect);
      }
      if (want.annotations === true) {
        sections.annotations = annotations.get(stem) ?? [];
      }
      if (want.history === true) {
        sections.history = history.get(stem) ?? [];
      }
      out.set(stem, sections);
    }
    return out;
  };

  const readSections: BodySectionStore['readSections'] = async (stem, want) =>
    (await readSectionsMany([stem], want)).get(stem) ?? {};

  return {
    readAnnotations: async (stem) =>
      (await readSections(stem, { annotations: true })).annotations ?? [],
    readDescription: async (stem) =>
      (await readSections(stem, { description: true })).description ?? null,
    readHistory: async (stem) => (await readSections(stem, { history: true })).history ?? [],
    readNext: async (stem) =>
      (await readSections(stem, { next: true })).next ?? { present: false, text: null },
    readSections,
    readSectionsMany,
  };
}
