/**
 * A snapshot of every record one board holds, so a write case pins the state
 * the CLI leaves behind and not only what it printed. A receipt echoes a few
 * fields; the snapshot reads the rest back through the Engine. It reads the
 * whole board, never the ids a case's output happens to name: an output format
 * changes what a write prints, never what it stores, so every format of one
 * write must pin the same records. Test-only.
 */
import { FACET_NAMES } from '@mimir/contract';

import type { ParityBoard } from './fixture';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** Every active Scratchpad of both boards' projects, sorted so random ids cannot reorder them. */
async function activePads(engine: ParityBoard['engine']): Promise<string[]> {
  const rows = await Promise.all(
    ['MMR', 'XX'].map((project) => read(() => engine.scratchList({ project }))),
  );
  return rows
    .flatMap((r) => (Array.isArray(r) ? r : [r]))
    .map((row) => JSON.stringify(row).replaceAll(UUID, '<uuid>'))
    .toSorted();
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
 * The state of every record on the board: all seeds, nodes, artifacts, and
 * projects of both boards, every Scratchpad it holds and each one a token
 * names (a removed pad reads as the way its read fails), each read through the
 * Engine. UUIDs, which differ by design, read as `<uuid>`.
 */
export async function boardSnapshot(
  board: ParityBoard,
  tokens: Readonly<Record<string, string>>,
): Promise<string> {
  const { engine } = board;
  const ids = await heldIds(board);
  const named = Object.entries(tokens).filter(([, value]) => IS_UUID.test(value));
  const unnamed = ids.pads.filter((id) => !named.some(([, value]) => value === id));
  const facets = [...FACET_NAMES];
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
    // Every active pad on the board, so a refused write that still left a pad behind shows.
    activePads: await activePads(engine),
    artifacts: await Promise.all(
      ids.artifacts.map(async (id) => [
        id,
        await read(() => engine.getArtifact({ content: true, id })),
      ]),
    ),
    // The board's own listings, the rows a reader sees, beside each record read whole below.
    board: Object.fromEntries(
      await Promise.all(
        ['MMR', 'XX'].map(async (project) => [
          project,
          {
            artifacts: await read(() => engine.artifacts({ project })),
            nodes: await read(() => engine.list({ facets, project, status: 'all' })),
          },
        ]),
      ),
    ),
    nodes: await Promise.all(
      ids.nodes.map(async (id) => [id, await read(() => engine.getNode({ facets, id }))]),
    ),
    projects: await engine.projects({ facets, status: 'all' }),
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
