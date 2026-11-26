import { describe, expect, it } from 'vitest';

import {
  archivedInListOrder,
  projectCountLine,
  projectPhoneCount,
  projectSetBack,
  projectsInListOrder,
} from '../lib/project-list';
import { stripRow } from './views-fixtures';

/*
 * The Projects list's order and words (ADR 0013, MMR-790 refinement): the
 * projects that need you first, then the most live work, then by name.
 */

const row = (key: string, name: string, needsYou: number, live: number) =>
  stripRow({ key, name }, { live, needsYou });

describe('the Projects list order (MMR-790)', () => {
  it('puts the projects that need you most first, then the most live work, then the name', () => {
    const ordered = projectsInListOrder([
      row('MDG', 'Modgud', 0, 0),
      row('NORN', 'Norn', 0, 36),
      row('MMR', 'Mimir', 1, 30),
      row('BFR', 'Bifrost Dashboard', 0, 0),
      row('HUGI', 'Hugi', 2, 18),
      row('ART', 'Muninn artifact server', 2, 14),
      row('TLG', 'dbtlr-tooling', 0, 6),
    ]);
    expect(ordered.map((p) => p.key)).toStrictEqual([
      'HUGI',
      'ART',
      'MMR',
      'NORN',
      'TLG',
      'BFR',
      'MDG',
    ]);
  });

  it('orders names without regard to case, and leaves its input as it was', () => {
    const input = [row('B', 'beta', 0, 0), row('A', 'Alpha', 0, 0), row('C', 'Gamma', 0, 0)];
    expect(projectsInListOrder(input).map((p) => p.name)).toStrictEqual(['Alpha', 'beta', 'Gamma']);
    expect(input.map((p) => p.key)).toStrictEqual(['B', 'A', 'C']);
  });
});

describe('the Projects list’s names (MMR-790)', () => {
  it('orders a number in a name by its value', () => {
    const ordered = projectsInListOrder([row('B', 'Site 10', 0, 0), row('A', 'Site 2', 0, 0)]);
    expect(ordered.map((p) => p.name)).toStrictEqual(['Site 2', 'Site 10']);
  });

  it('orders by name, not by key, when the counts tie', () => {
    const ordered = projectsInListOrder([row('AA', 'Zulu', 0, 0), row('ZZ', 'Alpha', 0, 0)]);
    expect(ordered.map((p) => p.key)).toStrictEqual(['ZZ', 'AA']);
  });

  it('breaks a tie of the same counts and name by key', () => {
    const ordered = projectsInListOrder([row('ZED', 'Twin', 1, 3), row('ABC', 'twin', 1, 3)]);
    expect(ordered.map((p) => p.key)).toStrictEqual(['ABC', 'ZED']);
  });

  it('orders the archived projects by title, as the active ones by name, and leaves its input as it was', () => {
    const archived = [{ title: 'Site 10' }, { title: 'site 2' }, { title: 'Alpha' }];
    expect(archivedInListOrder(archived).map((p) => p.title)).toStrictEqual([
      'Alpha',
      'site 2',
      'Site 10',
    ]);
    expect(archived.map((p) => p.title)).toStrictEqual(['Site 10', 'site 2', 'Alpha']);
  });
});

describe('the Projects count line (MMR-790)', () => {
  it('counts the active projects, singular at one, and says when there are none', () => {
    expect(projectCountLine(11)).toBe('11 projects');
    expect(projectCountLine(1)).toBe('1 project');
    expect(projectCountLine(0)).toBe('No projects');
  });
});

describe('a phone row’s one count (MMR-790)', () => {
  it('says how many need you while any do, as the attention pill', () => {
    expect(projectPhoneCount(row('A', 'A', 1, 0))).toStrictEqual({
      kind: 'attention',
      text: '1 needs you',
    });
    expect(projectPhoneCount(row('A', 'A', 2, 9))).toStrictEqual({
      kind: 'attention',
      text: '2 need you',
    });
  });

  it('otherwise says how much is live, and Nothing live with none, the row set back', () => {
    expect(projectPhoneCount(row('A', 'A', 0, 36))).toStrictEqual({
      kind: 'words',
      text: '36 live',
    });
    expect(projectPhoneCount(row('A', 'A', 0, 0))).toStrictEqual({
      kind: 'words',
      text: 'Nothing live',
    });
  });

  it('sets a project back only when nothing is live and nothing needs you', () => {
    expect(projectSetBack(row('A', 'A', 0, 0))).toBe(true);
    expect(projectSetBack(row('A', 'A', 1, 0))).toBe(false);
    expect(projectSetBack(row('A', 'A', 0, 1))).toBe(false);
  });
});
