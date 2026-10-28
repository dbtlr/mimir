import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from './testing/fixture';
import type { ParityBoard } from './testing/fixture';
import { loomMcpSession } from './testing/mcp';
import type { McpSession } from './testing/mcp';

/**
 * Inputs an MCP caller supplies that a command line cannot spell: an explicit
 * `false`, and a path to a file on the server's machine. The old server took
 * `pinned: false` and had no file input at all.
 */
let board: ParityBoard;
let server: McpSession;

beforeAll(async () => {
  board = await parityBoard();
  server = loomMcpSession(board.app('MMR'));
});

afterAll(async () => {
  await server.close();
  await board.close();
});

const pinnedOf = async (): Promise<unknown> => {
  const got = await server.call('get', { id: 'MMR' });
  return (got.structured as { pinned?: unknown }).pinned;
};

test('update with pinned true pins a project and pinned false unpins it, as the old tool did', async () => {
  expect((await server.call('update', { id: 'MMR', pinned: true })).isError).toBe(false);
  expect(await pinnedOf()).toBe(true);
  const unpinned = await server.call('update', { id: 'MMR', pinned: false });
  expect(unpinned.isError, unpinned.text).toBe(false);
  expect(await pinnedOf()).toBe(false);
});

test('pinned true with not-pinned true is refused', async () => {
  const both = await server.call('update', { id: 'MMR', 'not-pinned': true, pinned: true });
  expect(both.isError).toBe(true);
});

test.each(['attach', 'scratch_checkpoint'])('%s takes no file input', async (tool) => {
  const listed = await server.schema(tool);
  expect(Object.keys(listed.properties)).not.toContain('file');
});

test('attach naming a file is refused and stores nothing', async () => {
  const before = await server.call('list', { status: 'all' });
  const refused = await server.call('attach', {
    file: '/etc/hosts',
    project: 'MMR',
    title: 'hosts',
  });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain('file');
  const artifacts = await server.call('artifacts', { scope: 'MMR' });
  expect(JSON.stringify(artifacts.structured)).not.toContain('hosts');
  expect(before.isError).toBe(false);
});

test('scratch_checkpoint naming a file is refused', async () => {
  const pad = await board.engine.scratchCreate({ project: 'MMR', title: 'Pad' });
  const refused = await server.call('scratch_checkpoint', {
    'expected-updated-at': pad.updatedAt.toISOString(),
    file: '/etc/hosts',
    id: pad.id,
  });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain('file');
});
