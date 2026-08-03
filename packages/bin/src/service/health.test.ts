import { expect, test } from 'bun:test';

import { parseHealth } from './health';

test('parseHealth accepts the owned health response', () => {
  expect(parseHealth({ schema: 8, status: 'ok', version: '0.18.0-next.1' })).toEqual({
    schema: 8,
    status: 'ok',
    version: '0.18.0-next.1',
  });
});

test('parseHealth fails soft when an owned field is missing', () => {
  expect(parseHealth({ schema: 8, status: 'ok' })).toBeUndefined();
});

test('parseHealth fails soft when an owned field has the wrong type', () => {
  expect(parseHealth({ schema: '8', status: 'ok', version: '0.18.0' })).toBeUndefined();
  expect(parseHealth({ schema: 8, status: true, version: '0.18.0' })).toBeUndefined();
  expect(parseHealth({ schema: 8, status: 'ok', version: 18 })).toBeUndefined();
});
