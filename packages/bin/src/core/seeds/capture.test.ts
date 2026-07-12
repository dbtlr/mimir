import { describe, expect, test } from 'bun:test';

import { assertTitleWithinCap, SEED_TITLE_CAP, splitCapture } from './capture';

/**
 * The seed capture grammar (MMR-263) — one blob split at the first newline, an
 * explicit description winning over the split, and the hard title cap. Pure; the
 * integration test exercises the transports against a converged vault.
 */
describe('splitCapture', () => {
  test('a single line is a title-only capture (no body)', () => {
    expect(splitCapture('flaky login')).toEqual({ description: null, title: 'flaky login' });
  });

  test('splits at the FIRST newline — first line title, rest body (inner newlines kept)', () => {
    expect(splitCapture('title line\nbody one\nbody two')).toEqual({
      description: 'body one\nbody two',
      title: 'title line',
    });
  });

  test('the blank line between title and body is stripped from the body', () => {
    expect(splitCapture('title\n\nthe body prose')).toEqual({
      description: 'the body prose',
      title: 'title',
    });
  });

  test('title and body are trimmed of surrounding whitespace', () => {
    expect(splitCapture('  padded title  \n  padded body  ')).toEqual({
      description: 'padded body',
      title: 'padded title',
    });
  });

  test('an explicit description wins over the split body', () => {
    expect(splitCapture('title\nsplit body', 'explicit body')).toEqual({
      description: 'explicit body',
      title: 'title',
    });
    // A blank/empty explicit description clears the body to null (beats the split).
    expect(splitCapture('title\nsplit body', '   ')).toEqual({ description: null, title: 'title' });
    expect(splitCapture('title\nsplit body', null)).toEqual({ description: null, title: 'title' });
  });

  test('an absent explicit description (undefined) falls through to the split body', () => {
    expect(splitCapture('title\nbody', undefined).description).toBe('body');
  });
});

describe('assertTitleWithinCap', () => {
  test('accepts a title at the cap', () => {
    expect(() => assertTitleWithinCap('x'.repeat(SEED_TITLE_CAP))).not.toThrow();
  });

  test('errors over the cap with copy that teaches the split', () => {
    expect(() => assertTitleWithinCap('x'.repeat(SEED_TITLE_CAP + 1))).toThrow(
      /first line is the title/,
    );
  });
});
