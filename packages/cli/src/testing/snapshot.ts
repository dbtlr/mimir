/**
 * A snapshot of every record one board stores, so a write case pins the state
 * the CLI leaves behind and not only what it printed. A receipt echoes a few
 * fields; the snapshot reads the rest back through the Engine. It reads the
 * whole board, never the ids a case's output happens to name: an output format
 * changes what a write prints, never what it stores, so every format of one
 * write must pin the same records, and a write that touches a record other
 * than its subject shows. It holds what the store keeps and nothing core
 * derives from it: no status word, rollup, list row, or reverse edge, which
 * core's own tests prove, so a change to how core derives them re-records no
 * write pin. Test-only.
 */
import type { FacetName } from '@mimir/contract';

import type { ParityBoard } from './fixture';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A node's stored parts beyond its row: its prose, notes, log, tags, and its own prerequisite edges. */
const NODE_FACETS: readonly FacetName[] = [
  'deps',
  'description',
  'next',
  'annotations',
  'history',
  'tags',
];

/** A project's stored parts beyond its row: its tags and direction narrative. */
const PROJECT_FACETS: readonly FacetName[] = ['tags', 'next'];

/**
 * Fields core derives that a view carries with no facet asked for: the status
 * word (ADR 0008), a task's from its lifecycle, hold, and prerequisites and a
 * container's from its children, and a project's latest activity. The
 * derived facets, such as children and distribution, are never asked for.
 */
const DERIVED_FIELDS: ReadonlySet<string> = new Set(['lastActivityAt', 'status']);

/** Ids in one order on every board: by project, then by number. */
const byId = (ids: Iterable<string>): string[] =>
  [...new Set(ids)].toSorted((a, b) => a.localeCompare(b, 'en', { numeric: true }));

/** A read's value, or the way it failed, so a record a CLI wrongly removed (or a project it archived, which refuses reads) still compares. */
async function read(ask: () => Promise<unknown>): Promise<unknown> {
  try {
    return await ask();
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

/** A node or project view as the Engine returns it, read only for its edges. */
type EngineView = { readonly deps?: { readonly dependsOn: readonly { readonly id: string }[] } };

/**
 * A node or project view as the store holds it, its fields in the view's
 * order: no derived field, and of `deps` only the edges it declares, each
 * named by the prerequisite's id. The prerequisite's title and status belong
 * to that record, and the awaited and blocking sets are derived from the edges.
 */
function stored(view: EngineView): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(view)
      .filter(([field]) => !DERIVED_FIELDS.has(field))
      .map(([field, value]) =>
        field === 'deps' && view.deps !== undefined
          ? [field, { dependsOn: view.deps.dependsOn.map(({ id }) => ({ id })) }]
          : [field, value],
      ),
  );
}

/** The id of every node, artifact, and Scratchpad the store holds, read from its export. */
async function heldIds(board: ParityBoard) {
  const held = await board.store.export();
  return {
    artifacts: byId(held.artifacts.map((a) => `${a.key}-a${String(a.seq)}`)),
    nodes: byId(held.nodes.map((n) => n.id)),
    pads: byId(held.scratchpads.map((p) => p.id)),
  };
}

/**
 * The stored state of every record on the board: all seeds, nodes,
 * artifacts, and projects of both boards, every Scratchpad it holds and each
 * one a token names (a removed pad reads as the way its read fails), each
 * read through the Engine. UUIDs, which differ by design, read as `<uuid>`.
 */
export async function boardSnapshot(
  board: ParityBoard,
  tokens: Readonly<Record<string, string>>,
): Promise<string> {
  const { engine } = board;
  const ids = await heldIds(board);
  const named = Object.entries(tokens).filter(([, value]) => IS_UUID.test(value));
  const unnamed = ids.pads.filter((id) => !named.some(([, value]) => value === id));
  // A pad no token names, such as one the write created, is read under one label and sorted
  // by what it holds, so its random id cannot reorder it.
  const held = (
    await Promise.all(
      unnamed.map(async (id) =>
        JSON.stringify(await read(() => engine.scratchGet({ id }))).replaceAll(UUID, '<uuid>'),
      ),
    )
  ).toSorted();
  const snapshot = {
    artifacts: await Promise.all(
      ids.artifacts.map(async (id) => [
        id,
        await read(() => engine.getArtifact({ content: true, id })),
      ]),
    ),
    // Each project's tasks in board order, by id alone. A task's rank is stored, but no record
    // carries it as a field: the order of the board is how it reads (ADR 0007).
    board: Object.fromEntries(
      await Promise.all(
        ['MMR', 'XX'].map(async (project) => [
          project,
          {
            nodes: await read(async () => ({
              items: (await engine.list({ project, status: 'all' })).items.map(({ id }) => ({
                id,
              })),
            })),
          },
        ]),
      ),
    ),
    nodes: await Promise.all(
      ids.nodes.map(async (id) => [
        id,
        await read(async () => stored(await engine.getNode({ facets: [...NODE_FACETS], id }))),
      ]),
    ),
    projects: (await engine.projects({ facets: [...PROJECT_FACETS], status: 'all' })).map(stored),
    scratchpads: [
      ...(await Promise.all(
        named.map(async ([name, id]) => [name, await read(() => engine.scratchGet({ id }))]),
      )),
      ...held.map((pad) => ['<held>', JSON.parse(pad) as unknown]),
    ],
    seeds: Object.fromEntries(
      await Promise.all(
        ['MMR', 'XX'].map(async (project) => [
          project,
          await read(() => engine.seeds({ project, status: 'all' })),
        ]),
      ),
    ),
  };
  return JSON.stringify(snapshot, null, 2).replaceAll(UUID, '<uuid>');
}
