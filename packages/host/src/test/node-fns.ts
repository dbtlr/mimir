// Shared test seam module, not a test body.
// oxlint-disable vitest/require-hook
import { MimirError } from '@mimir/contract';
import type { EngineNode } from '@mimir/contract';

import {
  abandon,
  annotate,
  block,
  depend,
  done,
  getNode,
  groom,
  move,
  park,
  reopen,
  returnTask,
  scratchList,
  start,
  submit,
  tag,
  unblock,
  undepend,
  unpark,
  unqueue,
  untag,
  update,
} from '../api/fns/nodes';
import { FIXTURE_AT } from './engine-fixtures';
import type { engineNote, ScratchpadRow } from './node-fixtures';

/*
 * The node records' server functions served from a small world. A test file
 * that renders a node or project record mocks the module first —
 * `vi.mock('../api/fns/nodes')` — and then calls `serveNodes`, which answers
 * each read from the world it is given and echoes each write with the record
 * it names. A case that needs one answer of its own overrides that function
 * after, with `vi.mocked(fn).mockResolvedValueOnce(...)` or
 * `.mockRejectedValueOnce(...)`, and asserts the call by function:
 * `expect(done).toHaveBeenCalledWith({ data: { id } })`. See setup.ts for the
 * pattern.
 */

type Note = ReturnType<typeof engineNote>;

export type NodeWorld = {
  /** Every record the reads serve, projects included, by their own id. */
  nodes: EngineNode[];
  /** Notes by node id. */
  notes: Record<string, Note[]>;
  /** The active Scratchpads every board read answers. */
  scratchpads: ScratchpadRow[];
};

/** Answer the node server functions from `world`; the returned state is live. */
export function serveNodes(world: Partial<NodeWorld> = {}): NodeWorld {
  const state: NodeWorld = { nodes: [], notes: {}, scratchpads: [], ...world };
  const find = (id: string): EngineNode | undefined => state.nodes.find((n) => n.id === id);
  // A write echoes the record it names; one the world does not hold echoes a bare task.
  const echoOf = (id: string): EngineNode =>
    find(id) ?? {
      createdAt: FIXTURE_AT,
      id,
      parent: null,
      status: 'ready',
      title: id,
      type: 'task',
      updatedAt: FIXTURE_AT,
    };
  vi.mocked(getNode).mockImplementation(async ({ data }) => {
    const node = find(data.id);
    if (node === undefined) {
      throw new MimirError('not_found', `${data.id} doesn't exist`);
    }
    // A read of the annotations facet alone answers the notes, as the Engine would.
    if (data.facets?.length === 1 && data.facets[0] === 'annotations') {
      return { ...node, annotations: state.notes[data.id] ?? [] };
    }
    return node;
  });
  vi.mocked(scratchList).mockImplementation(async () => state.scratchpads);
  const echo = async ({ data }: { data: { id: string } }) => echoOf(data.id);
  for (const write of [
    abandon,
    annotate,
    block,
    depend,
    done,
    move,
    park,
    reopen,
    returnTask,
    start,
    submit,
    unblock,
    undepend,
    unpark,
    unqueue,
    update,
  ]) {
    vi.mocked(write).mockImplementation(echo);
  }
  vi.mocked(groom).mockImplementation(async ({ data }) => data.ids.map(echoOf));
  vi.mocked(tag).mockImplementation(async ({ data }) => data);
  vi.mocked(untag).mockImplementation(async ({ data }) => ({ ...data, removed: data.tags.length }));
  return state;
}

/**
 * For tests of the chrome around a page, which read only that the open record
 * exists: every node read answers a bare ready task of that id, and a
 * project's own record never answers.
 */
export function serveBareRecords(): void {
  serveNodes();
  vi.mocked(getNode).mockImplementation(async ({ data }) =>
    /^[A-Z]+$/.test(data.id)
      ? Promise.withResolvers<never>().promise
      : {
          createdAt: FIXTURE_AT,
          id: data.id,
          parent: null,
          status: 'ready',
          title: data.id,
          type: 'task',
          updatedAt: FIXTURE_AT,
        },
  );
}

/** Make the notes read fail while the records still load: the console's offline signal. */
export function failNotes(): void {
  const served = vi.mocked(getNode).getMockImplementation();
  if (served === undefined) {
    throw new Error('failNotes needs the node reads served first: call serveNodes()');
  }
  vi.mocked(getNode).mockImplementation(async (options) => {
    if (options.data.facets?.length === 1 && options.data.facets[0] === 'annotations') {
      throw new Error('unreachable');
    }
    return served(options);
  });
}
