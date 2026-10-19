/**
 * A snapshot of the records a write case can touch on one board, so twin
 * parity compares the state each CLI leaves behind and not only what it
 * printed. A receipt echoes a few fields; the snapshot reads the rest back
 * through the Engine. Test-only.
 */
import { FACET_NAMES } from '@mimir/contract';

import type { ParityBoard } from './fixture';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ARTIFACT_ID = /\b[A-Z]{2,4}-a\d+\b/g;
const NODE_ID = /\b[A-Z]{2,4}-\d+\b/g;

/** Every distinct match of `pattern` in `text`. */
const matches = (text: string, pattern: RegExp): string[] => [
  ...new Set(text.matchAll(pattern).map((m) => m[0])),
];

/** A read's value, or the way it failed, so a record a CLI wrongly removed still compares. */
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

/**
 * The state of every record the case names or its output echoes: all seeds,
 * nodes, artifacts, and projects of both boards, each Scratchpad by token or
 * echoed id, and each node and artifact id that appears. UUIDs, which differ by design, read as `<uuid>`.
 */
export async function boardSnapshot(
  board: ParityBoard,
  tokens: Readonly<Record<string, string>>,
  texts: readonly string[],
): Promise<string> {
  const { engine } = board;
  const text = texts.join('\n');
  const named = Object.entries(tokens).filter(([, value]) => matches(value, UUID).length > 0);
  const echoed = matches(text, UUID).filter((id) => !named.some(([, value]) => value === id));
  const pads: [string, string][] = [
    ...named.map(([name, id]): [string, string] => [name, id]),
    ...echoed.map((id): [string, string] => ['<echoed>', id]),
  ];
  const facets = [...FACET_NAMES];
  const snapshot = {
    // Every active pad on the board, so a refused write that still left a pad behind shows.
    activePads: await activePads(engine),
    artifacts: await Promise.all(
      matches(text, ARTIFACT_ID).map(async (id) => [
        id,
        await read(() => engine.getArtifact({ content: true, id })),
      ]),
    ),
    // Every node, artifact, and project the board holds, so a write that touches a record its output never names (a moved sibling, a re-ranked one) still compares.
    board: await Promise.all(
      ['MMR', 'XX'].map(async (project) => [
        await engine.list({ facets, project, status: 'all' }),
        await engine.artifacts({ project }),
      ]),
    ),
    nodes: await Promise.all(
      matches(text.replaceAll(ARTIFACT_ID, ''), NODE_ID).map(async (id) => [
        id,
        await read(() => engine.getNode({ facets, id })),
      ]),
    ),
    projects: await engine.projects({ facets, status: 'all' }),
    scratchpads: await Promise.all(
      pads.map(async ([name, id]) => [name, await read(() => engine.scratchGet({ id }))]),
    ),
    seeds: await Promise.all(
      ['MMR', 'XX'].map((project) => engine.seeds({ project, status: 'all' })),
    ),
  };
  return JSON.stringify(snapshot, null, 2).replaceAll(UUID, '<uuid>');
}
