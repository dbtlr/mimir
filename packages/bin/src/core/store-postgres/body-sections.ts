import type { AnnotationView, HistoryEntry } from '@mimir/contract';

import type { BodySections, BodySectionStore, NextFacet } from '../body-sections/store';
import type { Executor } from './tx';

/**
 * The Postgres body-section slice (ADR 0016 Phase 3). What Norn keeps as prose
 * sections of a markdown document — `## Task Description`, `## Next`,
 * `## Annotations`, `## History` — is columns and rows here, so this module is
 * the projection back onto the seam's facet shapes.
 *
 * `readSectionsMany` is a BATCH by construction: one query per requested facet
 * over the whole stem list, never one round trip per stem. The seam exists
 * because the Norn client serializes its calls (MMR-322); a relational backend
 * has no such limit, but a per-stem loop would still be N queries where one
 * `WHERE id IN (...)` does.
 */

/** A stored prose column as the seam yields it: trimmed, blank reads as none. */
function prose(value: string | null): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

/** The `## Next` facet from its two columns — presence is its own stored fact. */
function nextFacet(row: { next_present: boolean; next_text: string | null }): NextFacet {
  return { present: row.next_present, text: prose(row.next_text) };
}

/** Which of the requested stems name a node, and which a project. */
type Owners = {
  nodes: Map<
    string,
    { description: string | null; next_present: boolean; next_text: string | null }
  >;
  projects: Map<
    string,
    { description: string | null; next_present: boolean; next_text: string | null }
  >;
};

async function resolveOwners(ex: Executor, stems: readonly string[]): Promise<Owners> {
  if (stems.length === 0) {
    return { nodes: new Map(), projects: new Map() };
  }
  const nodeRows = await ex
    .selectFrom('node')
    .select(['id', 'description', 'next_present', 'next_text'])
    .where('id', 'in', [...stems])
    .execute();
  const projectRows = await ex
    .selectFrom('project')
    .select(['key', 'description', 'next_present', 'next_text'])
    .where('key', 'in', [...stems])
    .execute();
  return {
    nodes: new Map(nodeRows.map((row) => [row.id, row])),
    projects: new Map(projectRows.map((row) => [row.key, row])),
  };
}

/** The `## Annotations` rows of many nodes, keyed by stem, in append order. */
async function annotationsByStem(
  ex: Executor,
  stems: readonly string[],
): Promise<Map<string, AnnotationView[]>> {
  const out = new Map<string, AnnotationView[]>();
  if (stems.length === 0) {
    return out;
  }
  const rows = await ex
    .selectFrom('annotation')
    .select(['node_id', 'content', 'created_at'])
    .where('node_id', 'in', [...stems])
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
  return out;
}

/** The `## History` rows of many nodes and projects, keyed by stem, in log order. */
async function historyByStem(
  ex: Executor,
  stems: readonly string[],
): Promise<Map<string, HistoryEntry[]>> {
  const out = new Map<string, HistoryEntry[]>();
  if (stems.length === 0) {
    return out;
  }
  const rows = await ex
    .selectFrom('transition_log')
    .selectAll()
    .where((eb) => eb.or([eb('node_id', 'in', [...stems]), eb('project_key', 'in', [...stems])]))
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
      entry.handles = row.handles;
    }
    out.set(stem, [...(out.get(stem) ?? []), entry]);
  }
  return out;
}

export function createPostgresBodySectionStore(ex: Executor): BodySectionStore {
  const readSectionsMany: BodySectionStore['readSectionsMany'] = async (stems, want) => {
    const out = new Map<string, BodySections>();
    const unique = [...new Set(stems)];
    if (unique.length === 0) {
      return out;
    }
    const owners = await resolveOwners(ex, unique);
    const present = unique.filter((stem) => owners.nodes.has(stem) || owners.projects.has(stem));
    const annotations =
      want.annotations === true
        ? await annotationsByStem(
            ex,
            present.filter((stem) => owners.nodes.has(stem)),
          )
        : new Map<string, AnnotationView[]>();
    const history =
      want.history === true ? await historyByStem(ex, present) : new Map<string, HistoryEntry[]>();
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
        sections.next = nextFacet(row);
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
    // A relational store cannot hold an unresolvable section anchor — the
    // corruption this reports is a markdown-vault fault (a hand-duplicated
    // heading), and the columns behind it are always readable.
    annotationSectionFailures: () => Promise.resolve(new Set<string>()),
    readAnnotations: async (stem) =>
      (await readSections(stem, { annotations: true })).annotations ?? [],
    readDescription: async (stem) =>
      (await readSections(stem, { description: true })).description ?? null,
    readHistory: async (stem) => (await readSections(stem, { history: true })).history ?? [],
    readNext: async (stem) => {
      const facet = (await readSections(stem, { next: true })).next ?? {
        present: false,
        text: null,
      };
      // Neither degraded state a markdown document can reach is reachable here:
      // the section is a column pair, so it can be neither duplicated nor
      // missing its insertion anchor.
      return { ...facet, ambiguous: false, insertAnchors: 1 };
    },
    readSections,
    readSectionsMany,
  };
}
