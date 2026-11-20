import { describe, expect, it } from 'vitest';

import { commitTags, tagsOf } from '../components/ui/token-input';

const tag = (value: string) => ({ label: value, type: 'tag', value });

describe('commitTags', () => {
  it('turns text before a comma into a tag and keeps the rest as the draft', () => {
    const next = commitTags(['console, u'], false);
    expect(tagsOf(next)).toEqual(['console']);
    expect(next.at(-1)).toBe(' u');
  });

  it('turns all the text into a tag when flushed', () => {
    expect(tagsOf(commitTags([tag('console'), 'ui'], true))).toEqual(['console', 'ui']);
  });

  it('drops blank and repeated words', () => {
    expect(tagsOf(commitTags([tag('ui'), ' ,ui, ,new,'], false))).toEqual(['ui', 'new']);
  });

  it('leaves a word with no comma as the draft', () => {
    expect(commitTags([tag('ui'), 'con'], false)).toEqual([tag('ui'), 'con']);
  });
});
