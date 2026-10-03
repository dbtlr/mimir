import { expect, test } from 'bun:test';

import { helpForCommand } from './help';

test('doctor help describes the finding streams and offers no repair flag', () => {
  const help = helpForCommand('doctor', undefined, true, true);
  expect(help).toContain('json (pretty findings array) | jsonl (one finding per line)');
  expect(help).not.toContain('--fix');
  expect(help).not.toContain('--dry-run');
});
