import { describe, expect, it } from 'vitest';

import { t3ThreadLink } from '../lib/t3-link';

const ORIGIN = 'https://t3.example';
const handles = { harness: 't3', host: 'env-1', session: 'thread-1' };

describe('t3ThreadLink', () => {
  it('builds the link from the origin and both handles', () => {
    expect(t3ThreadLink(ORIGIN, handles)).toBe('https://t3.example/env-1/thread-1');
  });

  it('encodes each handle as one path segment', () => {
    expect(t3ThreadLink(ORIGIN, { ...handles, host: 'a/b', session: 'x y?' })).toBe(
      'https://t3.example/a%2Fb/x%20y%3F',
    );
  });

  it.each([
    ['no origin', null, handles],
    ['another harness', ORIGIN, { ...handles, harness: 'claude' }],
    ['no harness', ORIGIN, { ...handles, harness: null }],
    ['no host', ORIGIN, { ...handles, host: null }],
    ['an empty host', ORIGIN, { ...handles, host: '' }],
    ['no session', ORIGIN, { ...handles, session: undefined }],
    ['an empty session', ORIGIN, { ...handles, session: '' }],
    ['a dot host', ORIGIN, { ...handles, host: '.' }],
    ['a dot-dot host', ORIGIN, { ...handles, host: '..' }],
    ['a dot session', ORIGIN, { ...handles, session: '.' }],
    ['a dot-dot session', ORIGIN, { ...handles, session: '..' }],
  ])('answers null for %s', (_name, origin, given) => {
    expect(t3ThreadLink(origin, given)).toBeNull();
  });
});
