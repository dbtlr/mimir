import { describe, expect, it } from 'vitest';

import {
  artifactIdOf,
  artifactLink,
  artifactPath,
  bareIdRedirect,
  nodeIdOf,
  nodeLink,
  recordLink,
  seedLink,
} from '../lib/record-url';

describe('nodeLink (ADR 0013 v0.23)', () => {
  it('splits a node id at its hyphen into the project and the record suffix', () => {
    expect(nodeLink('MMR-417')).toStrictEqual({
      params: { key: 'MMR', seq: '417' },
      to: '/p/$key/$seq',
    });
  });
});

describe('seedLink (MMR-451)', () => {
  it('splits a seed id at its hyphen, keeping the s in the path', () => {
    expect(seedLink('MMR-s41')).toStrictEqual({
      params: { key: 'MMR', seq: '41' },
      to: '/p/$key/s{$seq}',
    });
  });
});

describe('artifactLink (MMR-452)', () => {
  it('splits an artifact id at its hyphen, keeping the a in the path', () => {
    expect(artifactLink('MMR-a219')).toStrictEqual({
      params: { key: 'MMR', seq: '219' },
      to: '/p/$key/a{$seq}',
    });
    expect(artifactPath('MMR-a219')).toBe('/p/MMR/a219');
  });
});

describe('artifactIdOf (MMR-452)', () => {
  it('joins a project key and a digit suffix into the artifact id, in any case', () => {
    expect(artifactIdOf('mmr', '219')).toBe('MMR-a219');
  });

  it('names no artifact off the grammar', () => {
    expect(artifactIdOf('MMR', '2x')).toBeUndefined();
    expect(artifactIdOf('M', '219')).toBeUndefined();
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

  it('sends a bare seed id to its seed page, in any case', () => {
    expect(bareIdRedirect('MMR-s41')).toStrictEqual(seedLink('MMR-s41'));
    expect(bareIdRedirect('mmr-S41')).toStrictEqual(seedLink('MMR-s41'));
  });

  it('sends a bare artifact id to its artifact page, in any case (MMR-452)', () => {
    expect(bareIdRedirect('MMR-a219')).toStrictEqual(artifactLink('MMR-a219'));
    expect(bareIdRedirect('mmr-A219')).toStrictEqual(artifactLink('MMR-a219'));
  });

  it('leaves anything off the grammar alone', () => {
    expect(bareIdRedirect('settings')).toBeUndefined();
    expect(bareIdRedirect('MMR-417/edit')).toBeUndefined();
    expect(bareIdRedirect('M-1')).toBeUndefined();
    expect(bareIdRedirect('')).toBeUndefined();
  });
});

describe('recordLink (MMR-455)', () => {
  it('opens a work node at its page and a project at its key', () => {
    expect(recordLink({ id: 'MMR-417', kind: 'task' })).toStrictEqual(nodeLink('MMR-417'));
    expect(recordLink({ id: 'MMR', kind: 'project' })).toStrictEqual({
      params: { key: 'MMR' },
      to: '/p/$key',
    });
  });

  it('opens a seed at its page (MMR-451)', () => {
    expect(recordLink({ id: 'MMR-s41', kind: 'seed' })).toStrictEqual(seedLink('MMR-s41'));
  });

  it('opens an artifact at its page (MMR-452)', () => {
    expect(recordLink({ id: 'MMR-a219', kind: 'artifact' })).toStrictEqual(
      artifactLink('MMR-a219'),
    );
  });
});
