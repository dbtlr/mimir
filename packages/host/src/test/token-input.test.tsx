import { describe, expect, it } from 'vitest';

import {
  pastedDuplicateEdits,
  tagEdits,
  tagsOf,
  withoutPastedDuplicates,
} from '../components/ui/token-input';

const tag = (value: string) => ({ label: value, type: 'tag', value });

// The editor's typing cannot be driven in jsdom (it reads the browser's own
// contenteditable edits), so commit-on-blur and caret placement are checked in a
// browser; these tests pin the edits the input applies.
describe('tagEdits', () => {
  it('turns the word before a comma into a chip in place, leaving the rest of the word', () => {
    // Offsets count a chip as one: "e," sits at 1-3, "xf" stays after the new chip.
    expect(tagEdits([tag('console'), 'e,xf'], false)).toEqual([
      { at: { end: 3, start: 1 }, content: [tag('e'), ' '] },
    ]);
  });

  it('leaves a word with no comma alone until flushed', () => {
    expect(tagEdits([tag('ui'), ' con'], false)).toEqual([]);
    expect(tagEdits([tag('ui'), ' con'], true)).toEqual([
      { at: { end: 5, start: 2 }, content: [tag('con'), ' '] },
    ]);
  });

  it('keeps text on either side of a chip as separate tags', () => {
    const edits = tagEdits(['foo', tag('ui'), 'bar'], true);
    expect(edits.flatMap((edit) => edit.content)).toEqual([tag('bar'), ' ', tag('foo'), ' ']);
  });

  it('lists edits right to left, so applying one leaves the earlier offsets valid', () => {
    expect(tagEdits(['foo', tag('ui'), 'bar'], true).map((edit) => edit.at.start)).toEqual([4, 0]);
  });

  it('drops a tag that differs from an existing one only by case, keeping the first spelling', () => {
    expect(tagEdits([tag('Bug'), ' bug,'], false)).toEqual([
      { at: { end: 6, start: 2 }, content: [] },
    ]);
    expect(tagEdits(['UI, ui, Ui,'], false)).toEqual([
      { at: { end: 11, start: 0 }, content: [tag('UI'), ' '] },
    ]);
  });

  it('drops blank words and leaves the spaces between chips alone', () => {
    expect(tagEdits([tag('ui'), ' ', tag('new'), ' '], true)).toEqual([]);
    expect(tagEdits([tag('ui'), ' ,'], false)).toEqual([{ at: { end: 3, start: 2 }, content: [] }]);
  });
});

describe('pastedDuplicateEdits', () => {
  const bug = tag('Bug');

  it('removes a pasted chip that repeats one already there, ignoring case', () => {
    const before = [bug, ' '];
    const after = [bug, ' ', tag('bug'), ' '];
    expect(pastedDuplicateEdits(before, after)).toEqual([
      { at: { end: 4, start: 2 }, content: [] },
    ]);
    expect(tagsOf(withoutPastedDuplicates(before, after))).toEqual(['Bug']);
  });

  it('keeps the first of two identical chips pasted together', () => {
    const after = [bug, ' ', bug, ' '];
    expect(tagsOf(withoutPastedDuplicates([], after))).toEqual(['Bug']);
  });

  it('keeps the chip already there when a case variant is pasted before it', () => {
    const before = [bug, ' '];
    const after = [tag('bug'), ' ', bug, ' '];
    expect(pastedDuplicateEdits(before, after)).toEqual([
      { at: { end: 2, start: 0 }, content: [] },
    ]);
    expect(tagsOf(withoutPastedDuplicates(before, after))).toEqual(['Bug']);
  });

  it('keeps duplicates the value already held before the paste', () => {
    const before = [bug, ' ', bug, ' '];
    const after = [...before, tag('ui'), ' '];
    expect(pastedDuplicateEdits(before, after)).toEqual([]);
    expect(tagsOf(withoutPastedDuplicates(before, after))).toEqual(['Bug', 'Bug', 'ui']);
  });
});
