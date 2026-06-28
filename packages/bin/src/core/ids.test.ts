import { describe, expect, test } from 'bun:test';

import { parseId, parseIdentity, renderArtifactRef, renderId } from './ids';

describe('renderId', () => {
  test('joins key and seq as KEY-seq', () => {
    expect(renderId({ key: 'MMR', seq: 16 })).toBe('MMR-16');
  });
});

describe('parseId', () => {
  test('parses a well-formed id', () => {
    expect(parseId('MMR-16')).toEqual({ key: 'MMR', seq: 16 });
    expect(parseId('AB-1')).toEqual({ key: 'AB', seq: 1 });
  });

  test('rejects malformed ids', () => {
    expect(parseId('mmr-16')).toBeNull(); // lowercase key
    expect(parseId('MMR16')).toBeNull(); // no separator
    expect(parseId('MMR-')).toBeNull(); // no seq
    expect(parseId('TOOLONG-1')).toBeNull(); // key length > 4
    expect(parseId('M-1')).toBeNull(); // key length < 2
    expect(parseId('MMR-1x')).toBeNull(); // non-numeric seq
  });

  test('round-trips with renderId', () => {
    const ref = { key: 'WXYZ', seq: 4096 };
    expect(parseId(renderId(ref))).toEqual(ref);
  });
});

describe('renderArtifactRef', () => {
  test('joins key and seq as KEY-aN', () => {
    expect(renderArtifactRef({ key: 'MMR', seq: 3 })).toBe('MMR-a3');
  });
});

describe('parseIdentity', () => {
  test('a bare KEY is a project', () => {
    expect(parseIdentity('MMR')).toEqual({ kind: 'project', key: 'MMR' });
    expect(parseIdentity('AB')).toEqual({ kind: 'project', key: 'AB' });
  });

  test('KEY-seq is a node', () => {
    expect(parseIdentity('MMR-16')).toEqual({ kind: 'node', key: 'MMR', seq: 16 });
  });

  test('KEY-aN is an artifact', () => {
    expect(parseIdentity('MMR-a1')).toEqual({ kind: 'artifact', key: 'MMR', seq: 1 });
    expect(parseIdentity(renderArtifactRef({ key: 'WXYZ', seq: 42 }))).toEqual({
      kind: 'artifact',
      key: 'WXYZ',
      seq: 42,
    });
  });

  test('rejects malformed tokens', () => {
    expect(parseIdentity('mmr')).toBeNull(); // lowercase key
    expect(parseIdentity('M')).toBeNull(); // key too short
    expect(parseIdentity('TOOLONG')).toBeNull(); // key too long
    expect(parseIdentity('MMR-')).toBeNull(); // dangling separator
    expect(parseIdentity('MMR-a')).toBeNull(); // artifact marker, no seq
    expect(parseIdentity('MMR-b1')).toBeNull(); // unknown marker
    expect(parseIdentity('#1')).toBeNull(); // the dead Phase-3 echo form
  });
});
