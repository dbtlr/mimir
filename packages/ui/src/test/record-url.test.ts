import { describe, expect, it } from 'vitest';

import { bareIdRedirect, nodeIdOf, nodeLink } from '../lib/record-url';

describe('nodeLink (ADR 0013 v0.23)', () => {
  it('splits a node id at its hyphen into the project and the record suffix', () => {
    expect(nodeLink('MMR-417')).toStrictEqual({
      params: { key: 'MMR', seq: '417' },
      to: '/p/$key/$seq',
    });
  });
});

describe('nodeIdOf', () => {
  it('joins a project key and an all-digit suffix back into the node id', () => {
    expect(nodeIdOf('MMR', '417')).toBe('MMR-417');
  });

  it('reads the key in any case, as the bare-id redirect does', () => {
    expect(nodeIdOf('mmr', '417')).toBe('MMR-417');
  });

  it('names no node for a seed or artifact suffix', () => {
    expect(nodeIdOf('MMR', 's41')).toBeUndefined();
    expect(nodeIdOf('MMR', 'a219')).toBeUndefined();
  });
});

describe('bareIdRedirect', () => {
  it('sends a bare node id to its record page', () => {
    expect(bareIdRedirect('MMR-417')).toStrictEqual(nodeLink('MMR-417'));
  });

  it('accepts any case', () => {
    expect(bareIdRedirect('mmr-417')).toStrictEqual(nodeLink('MMR-417'));
  });

  it('sends a bare project key to its project page', () => {
    expect(bareIdRedirect('mmr')).toStrictEqual({ params: { key: 'MMR' }, to: '/p/$key' });
  });

  it('leaves seed and artifact ids alone until their pages exist', () => {
    expect(bareIdRedirect('MMR-s41')).toBeUndefined();
    expect(bareIdRedirect('MMR-a219')).toBeUndefined();
  });

  it('leaves anything off the grammar alone', () => {
    expect(bareIdRedirect('settings')).toBeUndefined();
    expect(bareIdRedirect('MMR-417/edit')).toBeUndefined();
    expect(bareIdRedirect('M-1')).toBeUndefined();
    expect(bareIdRedirect('')).toBeUndefined();
  });
});
