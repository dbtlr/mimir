import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from './testing/fixture';
import type { ParityBoard } from './testing/fixture';
import { loomMcpSession } from './testing/mcp';

/**
 * MCP capabilities (ADR 0037): the machine-local and installer commands stay
 * off MCP. `engine-surface.test.ts` proves every Engine method is reachable as
 * a tool or a command.
 */
let board: ParityBoard;
let loomTools: string[];

beforeAll(async () => {
  board = await parityBoard();
  const loom = loomMcpSession(board.app('MMR'));
  loomTools = await loom.tools();
  await loom.close();
});

afterAll(async () => {
  await board.close();
});

test('the machine-local and installer commands are not tools', () => {
  const machine = [
    'bind',
    'doctor',
    'pair',
    'store',
    'version',
    'skills',
    'self_update',
    'mcp',
    'installation_protocol',
    'installation_install',
  ];
  expect(loomTools.filter((tool) => machine.some((name) => tool.startsWith(name)))).toEqual([]);
});
