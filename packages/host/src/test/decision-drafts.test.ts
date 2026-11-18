import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pruneDrafts, readDraft, removeDraft, writeDraft } from '../lib/decision-drafts';
import type { DecisionDraft } from '../lib/decision-drafts';

const draft = (set: string, over: Partial<DecisionDraft> = {}): DecisionDraft => ({
  answer: '',
  choice: 2,
  note: 'n',
  set,
  ...over,
});

const boom = () => {
  throw new Error('denied');
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('decision drafts', () => {
  it('reads back what was written, and null when none is kept', () => {
    expect(readDraft('MMR-q1')).toBeNull();
    writeDraft('MMR-q1', draft('MMR-d3', { answer: 'mine', choice: 'custom' }));
    expect(readDraft('MMR-q1')).toStrictEqual(
      draft('MMR-d3', { answer: 'mine', choice: 'custom' }),
    );
  });

  it('replaces an earlier draft and removes one', () => {
    writeDraft('MMR-q1', draft('MMR-d3'));
    writeDraft('MMR-q1', draft('MMR-d3', { note: 'later' }));
    expect(readDraft('MMR-q1')?.note).toBe('later');
    removeDraft('MMR-q1');
    expect(readDraft('MMR-q1')).toBeNull();
  });

  it('reads corrupt JSON or a wrong shape as no draft', () => {
    localStorage.setItem('mimir-decision-draft:MMR-q1', '{not json');
    expect(readDraft('MMR-q1')).toBeNull();
    localStorage.setItem('mimir-decision-draft:MMR-q2', JSON.stringify({ choice: 0, note: 1 }));
    expect(readDraft('MMR-q2')).toBeNull();
  });

  it('prunes the set’s drafts of decisions that left it, and keeps other sets and keys', () => {
    writeDraft('MMR-q1', draft('MMR-d3'));
    writeDraft('MMR-q2', draft('MMR-d3'));
    writeDraft('MMR-q3', draft('MMR-d4'));
    localStorage.setItem('unrelated', 'x');
    pruneDrafts('MMR-d3', ['MMR-q1']);
    expect(readDraft('MMR-q1')).not.toBeNull();
    expect(readDraft('MMR-q2')).toBeNull();
    expect(readDraft('MMR-q3')).not.toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('x');
  });

  it('ignores storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'key').mockImplementation(boom);
    expect(readDraft('MMR-q1')).toBeNull();
    expect(() => {
      writeDraft('MMR-q1', draft('MMR-d3'));
      removeDraft('MMR-q1');
      pruneDrafts('MMR-d3', []);
    }).not.toThrow();
  });
});
