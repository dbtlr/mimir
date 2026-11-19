import { expect, test } from 'vitest';

import { linkBackAction, markState, readMark } from '../lib/walkthrough-mark';

test('a mark records the opener and its entry, and reads back from history state', () => {
  const mark = { entry: 'delivery:MMR-d3', opener: '/p/MMR' };
  expect(readMark(markState(mark))).toStrictEqual(mark);
  expect(readMark({ __TSR_index: 3, ...markState(mark) })).toStrictEqual(mark);
});

test('a mark with no entry, as releases before MMR-714 wrote, still reads with its opener', () => {
  expect(readMark({ walkthroughOpener: '/' })).toStrictEqual({ entry: undefined, opener: '/' });
  expect(readMark({ walkthroughEntry: 5, walkthroughOpener: '/' })).toStrictEqual({
    entry: undefined,
    opener: '/',
  });
});

test('no opener makes no mark, and foreign state reads as unmarked', () => {
  expect(markState(undefined)).toBeUndefined();
  expect(readMark(undefined)).toBeUndefined();
  expect(readMark({ __TSR_index: 1 })).toBeUndefined();
  expect(readMark({ walkthroughOpener: 4 })).toBeUndefined();
});

test('the link back goes back only when the opener is the walkthrough’s own page', () => {
  expect(linkBackAction('/p/MMR/d3', '/p/MMR/d3')).toBe('back');
  expect(linkBackAction('/', '/p/MMR/d3')).toBe('replace');
  expect(linkBackAction(undefined, '/p/MMR/d3')).toBe('replace');
});
