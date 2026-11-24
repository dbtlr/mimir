import type { EngineSearchHit } from '@mimir/contract';
import { afterEach, describe, expect, it } from 'vitest';

import { groupHits, highlightTerms, paletteReturnTarget } from '../lib/jump';
import { searchHit } from './engine-fixtures';

const hit = (id: string, match: EngineSearchHit['match']) => searchHit({ id, match, title: id });

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

/** A button appended to `parent`. */
function button(parent: HTMLElement = document.body): HTMLButtonElement {
  const element = document.createElement('button');
  parent.append(element);
  return element;
}

describe('paletteReturnTarget (MMR-729)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('returns the first candidate that can still take focus', () => {
    const opener = button();
    const jump = button();
    expect(paletteReturnTarget([opener, jump])).toBe(opener);
  });

  it('passes over a candidate that has left the page', () => {
    const gone = document.createElement('button');
    const jump = button();
    expect(paletteReturnTarget([gone, null, jump])).toBe(jump);
  });

  it('passes over a control in a yielded, inert sidebar', () => {
    const sidebar = document.createElement('div');
    sidebar.setAttribute('inert', '');
    document.body.append(sidebar);
    expect(paletteReturnTarget([button(sidebar)])).toBeNull();
  });

  it('passes over a control the layout hides, such as one under lg:hidden past a resize', () => {
    const hidden = button();
    Object.defineProperty(hidden, 'checkVisibility', { value: () => false });
    const jump = button();
    expect(paletteReturnTarget([hidden, jump])).toBe(jump);
  });

  it('passes over the page itself, which had focus when nothing else did', () => {
    expect(paletteReturnTarget([document.body])).toBeNull();
  });
});
