import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from './testing/fixture';
import type { ParityBoard } from './testing/fixture';
import { runArgv } from './testing/run';

/**
 * The binary serves MCP over stdio only (ADR 0010). Loom's `mcp()` also offers
 * `--http`, with no authentication unless an application supplies one, so
 * mimir refuses it before any server starts.
 */
let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

test.each([['0'], ['127.0.0.1:0'], ['0.0.0.0:0']])(
  'mcp --http %s is a usage error that serves nothing',
  async (address) => {
    const run = await runArgv(board.app(), ['mcp', '--http', address]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('mimir serves MCP over stdin and stdout only');
    expect(run.stdout).toBe('');
  },
);
