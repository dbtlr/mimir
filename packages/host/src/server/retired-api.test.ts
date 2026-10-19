import { expect, test } from 'bun:test';

import { retiredApiResponse } from './retired-api';

test('the retired /api answers 410 gone with an uncacheable JSON refusal that names /trpc', async () => {
  const response = retiredApiResponse();
  expect(response.status).toBe(410);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as {
    error: { code: string; hint: string; message: string };
  };
  expect(body.error.code).toBe('gone');
  expect(body.error.message).toContain('/api was retired');
  expect(body.error.hint).toContain('/trpc');
});
