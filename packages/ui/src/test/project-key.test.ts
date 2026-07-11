import { describe, expect } from 'vitest';

import { suggestKey } from '../lib/project-key';

describe('suggestKey (MMR-230)', () => {
  it('takes uppercase initials of a multi-word title', () => {
    expect(suggestKey('Signal relay')).toBe('SR');
    expect(suggestKey('fixture vault generator')).toBe('FVG');
  });

  it('clamps initials to four characters', () => {
    expect(suggestKey('alpha bravo charlie delta echo')).toBe('ABCD');
  });

  it('falls back to leading consonants for a single word', () => {
    expect(suggestKey('Signal')).toBe('SGN');
    expect(suggestKey('Meridian')).toBe('MRD');
  });

  it('keeps a short single word whole', () => {
    expect(suggestKey('ab')).toBe('AB');
  });

  it('ignores digits and punctuation', () => {
    expect(suggestKey('Project 9: relaunch!')).toBe('PR');
  });

  it('returns empty when the title has no letters', () => {
    expect(suggestKey('123 !!!')).toBe('');
    expect(suggestKey('')).toBe('');
  });
});
