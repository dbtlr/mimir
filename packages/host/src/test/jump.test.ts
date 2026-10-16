import { describe, expect, it } from 'vitest';

import type { WireSearchHit } from '../api/types';
import { groupHits, highlightTerms } from '../lib/jump';

const hit = (id: string, match: WireSearchHit['match']): WireSearchHit => ({
  finished: false,
  id,
  kind: 'task',
  lifecycle: 'todo',
  match,
  project: 'MMR',
  title: id,
  updated_at: '2026-10-01T10:00:00.000Z',
});

describe('groupHits (MMR-455)', () => {
  it('groups hits by how they matched, keeping the search ranking inside each group', () => {
    const groups = groupHits([
      hit('MMR-3', 'title'),
      hit('MMR-1', 'title'),
      hit('MMR-2', 'description'),
    ]);
    expect(groups.map((g) => [g.label, g.hits.map((h) => h.id)])).toStrictEqual([
      ['Titles', ['MMR-3', 'MMR-1']],
      ['Descriptions', ['MMR-2']],
    ]);
  });

  it('puts an ID match before its linked records', () => {
    const groups = groupHits([hit('MMR-417', 'id'), hit('MMR-414', 'link')]);
    expect(groups.map((g) => g.label)).toStrictEqual(['Record', 'Linked']);
  });
});

describe('highlightTerms', () => {
  it('marks every occurrence of each query word, in any case', () => {
    expect(highlightTerms('Add the SQLite dialect', 'sqlite DIALECT')).toStrictEqual([
      { mark: false, text: 'Add the ' },
      { mark: true, text: 'SQLite' },
      { mark: false, text: ' ' },
      { mark: true, text: 'dialect' },
    ]);
  });

  it('leaves a fuzzy hit unmarked when no word appears whole', () => {
    expect(highlightTerms('Add the SQLite dialect', 'sqdl')).toStrictEqual([
      { mark: false, text: 'Add the SQLite dialect' },
    ]);
  });

  it('treats regular-expression characters in the query literally', () => {
    expect(highlightTerms('Fix a+b parsing', 'a+b')).toStrictEqual([
      { mark: false, text: 'Fix ' },
      { mark: true, text: 'a+b' },
      { mark: false, text: ' parsing' },
    ]);
  });
});
