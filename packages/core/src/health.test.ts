import { expect, test } from 'bun:test';

import { healthOf, healthSchema } from './health';

test('health advertises the build and minimum client without a store', () => {
  expect(healthOf('0.26.0-next.10')).toMatchObject({
    minClient: '0.26.0-next',
    status: 'ok',
    version: '0.26.0-next.10',
  });
  expect(healthSchema.safeParse({ schema: 8, status: 'ok', version: '0.26.0' }).success).toBe(
    false,
  );
});
