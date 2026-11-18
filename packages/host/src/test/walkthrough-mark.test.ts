import { expect, test } from 'vitest';

import { closeAction, linkBackAction, markState, readMark } from '../lib/walkthrough-mark';

test('a mark records the opener and reads back from history state', () => {
  expect(readMark(markState('/p/MMR'))).toBe('/p/MMR');
  expect(readMark({ __TSR_index: 3, ...markState('/') })).toBe('/');
});

test('no opener makes no mark, and foreign state reads as unmarked', () => {
  expect(markState(undefined)).toBeUndefined();
  expect(readMark(undefined)).toBeUndefined();
  expect(readMark({ __TSR_index: 1 })).toBeUndefined();
  expect(readMark({ walkthroughOpener: 4 })).toBeUndefined();
});

test('Close goes back on a marked walkthrough and replaces on an unmarked one', () => {
  expect(closeAction('/p/MMR')).toBe('back');
  expect(closeAction(undefined)).toBe('replace');
});

test('the link back goes back only when the opener is the walkthrough’s own page', () => {
  expect(linkBackAction('/p/MMR/d3', '/p/MMR/d3')).toBe('back');
  expect(linkBackAction('/', '/p/MMR/d3')).toBe('replace');
  expect(linkBackAction(undefined, '/p/MMR/d3')).toBe('replace');
});
