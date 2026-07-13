import { expect, test } from 'bun:test';

import { helpForCommand } from './help';

test('doctor help distinguishes bare finding streams from composite repair reports', () => {
  const help = helpForCommand('doctor', undefined, true);
  expect(help).toContain(
    'without --fix: json (pretty findings array) | jsonl (one finding per line)',
  );
  expect(help).toContain(
    '--fix: json (composite report) | jsonl (one issue/detail per line plus summary)',
  );
});
