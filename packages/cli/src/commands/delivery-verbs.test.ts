import { expect, test } from 'bun:test';

import { parityBoard } from '../testing/fixture';
import { loomMcpSession } from '../testing/mcp';
import { runArgv } from '../testing/run';

test('delivery start ignores shell identity, refuses every explicit task handle and block owner, and MCP dispatches delivery ids', async () => {
  const board = await parityBoard();
  try {
    await board.engine.deliveryCreate({
      agreement: 'Terms',
      phase: 'MMR-2',
      tasks: ['MMR-3'],
      title: 'Attempt',
    });
    for (const flag of [
      'branch',
      'harness',
      'host',
      'session',
      'worker-harness',
      'worker-session',
    ]) {
      const refusal = await runArgv(board.app(), ['start', 'MMR-d1', `--${flag}`, 'explicit']);
      expect(refusal.exitCode).toBe(1);
      expect(refusal.stderr).toContain('refuses task handle');
    }
    expect((await runArgv(board.app(), ['block', 'MMR-d1', 'wait', '--on', 'you'])).exitCode).toBe(
      1,
    );
    expect((await runArgv(board.app(), ['land', 'MMR-d1', '--', 'unused'])).exitCode).toBe(2);
    const run = await runArgv(board.app(), ['start', 'MMR-d1', '-f', 'json'], {
      env: {
        CODEX_THREAD_ID: 'ambient',
        T3CODE_ENVIRONMENT_ID: 'machine',
        T3CODE_THREAD_ID: 'thread',
      },
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout).session).toBeNull();
    const session = loomMcpSession(board.app());
    try {
      const reply = await session.call('submit', { id: 'MMR-d1' });
      expect(reply.isError).not.toBe(true);
      expect((await board.engine.getDelivery({ id: 'MMR-d1' })).lifecycle).toBe('milestone');
    } finally {
      await session.close();
    }
  } finally {
    await board.close();
  }
});
