import { expect, test } from 'bun:test';

import { formatSelfUpdateJson } from './format';
import type { SelfUpdateResult } from './format';

test('an applied update', () => {
  const r: SelfUpdateResult = {
    asset: 'mimir-darwin-arm64',
    from: '0.6.0',
    to: '0.7.0',
    updated: true,
  };
  expect(JSON.parse(formatSelfUpdateJson(r, true))).toEqual({
    asset: 'mimir-darwin-arm64',
    from: '0.6.0',
    to: '0.7.0',
    updated: true,
  });
});

test('already current → updated false, to equals from', () => {
  const r: SelfUpdateResult = {
    asset: 'mimir-darwin-arm64',
    from: '0.6.0',
    to: '0.6.0',
    updated: false,
  };
  const parsed = JSON.parse(formatSelfUpdateJson(r, true));
  expect(parsed.updated).toBe(false);
  expect(parsed.to).toBe(parsed.from);
});
