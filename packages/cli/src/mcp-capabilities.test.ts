import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from './testing/fixture';
import type { ParityBoard } from './testing/fixture';
import { loomMcpSession } from './testing/mcp';
import type { ToolAnnotations } from './testing/mcp';

/**
 * MCP capabilities (ADR 0037): the machine-local and installer commands stay
 * off MCP. `engine-surface.test.ts` proves every Engine method is reachable as
 * a tool or a command.
 */
let board: ParityBoard;
let loomTools: string[];
let loomAnnotations: Map<string, ToolAnnotations>;

beforeAll(async () => {
  board = await parityBoard();
  const loom = loomMcpSession(board.app('MMR'));
  loomTools = await loom.tools();
  loomAnnotations = await loom.annotations();
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

/**
 * MCP reads a missing `readOnlyHint` as false and a missing `destructiveHint`
 * as true, and a client or proxy may filter on either without the other, so
 * every tool states both. The values themselves are pinned in `mcp-parity.txt`.
 */
test('every tool declares a boolean readOnlyHint and destructiveHint', () => {
  expect(loomAnnotations.size).toBeGreaterThan(0);
  const undeclared = [...loomAnnotations]
    .filter(
      ([, hints]) =>
        typeof hints.readOnlyHint !== 'boolean' || typeof hints.destructiveHint !== 'boolean',
    )
    .map(([name]) => name);
  expect(undeclared).toEqual([]);
});
