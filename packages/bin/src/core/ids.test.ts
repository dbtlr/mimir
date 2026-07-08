import { describe, expect, test } from 'bun:test';

import {
  parseId,
  parseIdentity,
  parseSeedRef,
  renderArtifactRef,
  renderId,
  renderSeedRef,
} from './ids';

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

describe('renderSeedRef', () => {
  test('joins key and seq as KEY-sN', () => {
    expect(renderSeedRef({ key: 'MMR', seq: 3 })).toBe('MMR-s3');
  });
});

describe('parseSeedRef', () => {
  test('parses a well-formed seed id', () => {
    expect(parseSeedRef('MMR-s7')).toEqual({ key: 'MMR', seq: 7 });
    expect(parseSeedRef('AB-s1')).toEqual({ key: 'AB', seq: 1 });
  });

  test('rejects non-seed tokens', () => {
    expect(parseSeedRef('MMR-7')).toBeNull(); // node
    expect(parseSeedRef('MMR-a7')).toBeNull(); // artifact
    expect(parseSeedRef('mmr-s7')).toBeNull(); // lowercase key
    expect(parseSeedRef('MMR-s')).toBeNull(); // no seq
    expect(parseSeedRef('MMR-s1x')).toBeNull(); // non-numeric seq
  });

  test('round-trips with renderSeedRef', () => {
    const ref = { key: 'WXYZ', seq: 4096 };
    expect(parseSeedRef(renderSeedRef(ref))).toEqual(ref);
  });
});

describe('parseIdentity', () => {
  test('a bare KEY is a project', () => {
    expect(parseIdentity('MMR')).toEqual({ key: 'MMR', kind: 'project' });
    expect(parseIdentity('AB')).toEqual({ key: 'AB', kind: 'project' });
  });

  test('KEY-seq is a node', () => {
    expect(parseIdentity('MMR-16')).toEqual({ key: 'MMR', kind: 'node', seq: 16 });
  });

  test('KEY-aN is an artifact', () => {
    expect(parseIdentity('MMR-a1')).toEqual({ key: 'MMR', kind: 'artifact', seq: 1 });
    expect(parseIdentity(renderArtifactRef({ key: 'WXYZ', seq: 42 }))).toEqual({
      key: 'WXYZ',
      kind: 'artifact',
      seq: 42,
    });
  });

  test('KEY-sN is a seed', () => {
    expect(parseIdentity('MMR-s1')).toEqual({ key: 'MMR', kind: 'seed', seq: 1 });
    expect(parseIdentity(renderSeedRef({ key: 'WXYZ', seq: 42 }))).toEqual({
      key: 'WXYZ',
      kind: 'seed',
      seq: 42,
    });
  });

  test('rejects malformed tokens', () => {
    expect(parseIdentity('mmr')).toBeNull(); // lowercase key
    expect(parseIdentity('M')).toBeNull(); // key too short
    expect(parseIdentity('TOOLONG')).toBeNull(); // key too long
    expect(parseIdentity('MMR-')).toBeNull(); // dangling separator
    expect(parseIdentity('MMR-a')).toBeNull(); // artifact marker, no seq
    expect(parseIdentity('MMR-s')).toBeNull(); // seed marker, no seq
    expect(parseIdentity('MMR-b1')).toBeNull(); // unknown marker
    expect(parseIdentity('#1')).toBeNull(); // the dead Phase-3 echo form
  });
});
