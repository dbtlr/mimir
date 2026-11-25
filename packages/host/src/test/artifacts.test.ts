import { describe, expect } from 'vitest';

import { kindName, kindTagLabel, kindTagOptions, splitKindTags } from '../lib/artifacts';

describe('an artifact’s kind (MMR-725)', () => {
  it('reads a kind: tag first, before a bare kind tag earlier in the list', () => {
    expect(splitKindTags(['spec', 'doctor', 'kind:shaping'])).toStrictEqual({
      kind: 'shaping',
      rest: ['spec', 'doctor'],
    });
  });

  it('reads the first bare kind tag when no kind: tag is set', () => {
    expect(splitKindTags(['workspace_unconsolidated', 'report', 'spec'])).toStrictEqual({
      kind: 'report',
      rest: ['workspace_unconsolidated', 'spec'],
    });
  });

  it.each(['session_summary', 'plan', 'mock', 'investigation', 'spike', 'audit', 'verification'])(
    'reads the bare %s tag as a kind',
    (tag) => {
      expect(splitKindTags([tag]).kind).toBe(tag);
    },
  );

  it('reads no kind from plain tags, workspace_unconsolidated included', () => {
    expect(splitKindTags(['workspace_unconsolidated', 'doctor'])).toStrictEqual({
      kind: undefined,
      rest: ['workspace_unconsolidated', 'doctor'],
    });
  });

  it('keeps a second kind: tag and a bare "kind:" as plain tags', () => {
    expect(splitKindTags(['kind:spec', 'kind:session', 'kind:'])).toStrictEqual({
      kind: 'spec',
      rest: ['kind:session', 'kind:'],
    });
  });

  it('names a kind in sentence case, as a word', () => {
    expect(kindName('session_summary')).toBe('Session summary');
    expect(kindName('spec')).toBe('Spec');
  });
});

describe('kind tags as filter values', () => {
  it('names a kind tag by its kind, and a plain tag not at all', () => {
    expect(kindTagLabel('kind:spec')).toBe('spec');
    expect(kindTagLabel('session_summary')).toBe('session_summary');
    expect(kindTagLabel('doctor')).toBeUndefined();
    expect(kindTagLabel('workspace_unconsolidated')).toBeUndefined();
  });

  it('offers the fixed kinds in order, then kind: tags the rows show or the URL chose, once each', () => {
    const options = kindTagOptions([['kind:review', 'spec'], ['kind:review']], 'kind:other');
    expect(options.map((o) => o.label)).toStrictEqual([
      'Session summary',
      'Spec',
      'Plan',
      'Mock',
      'Investigation',
      'Report',
      'Spike',
      'Audit',
      'Verification',
      'Review',
      'Other',
    ]);
    expect(options.at(-2)?.tag).toBe('kind:review');
  });

  it('does not offer a plain tag as a kind', () => {
    const values = kindTagOptions([['doctor']], 'doctor').map((o) => o.tag);
    expect(values).not.toContain('doctor');
  });
});
