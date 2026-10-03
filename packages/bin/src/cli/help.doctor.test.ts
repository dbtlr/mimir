import { expect, test } from 'bun:test';

import { helpForCommand } from './help';

test('doctor help describes the finding streams and that --fix is refused', () => {
  const help = helpForCommand('doctor', undefined, true, true);
  expect(help).toContain('json (pretty findings array) | jsonl (one finding per line)');
  expect(help).toContain('--fix is refused: neither backend has a repair pass');
});
