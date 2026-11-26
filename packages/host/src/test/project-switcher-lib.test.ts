import { describe, expect, it } from 'vitest';

import {
  filterProjects,
  groupProjects,
  overlayPins,
  projectSwitchTarget,
  homeShortlist,
} from '../lib/project-switcher';
import { engineProject } from './engine-fixtures';

const atDay = (day: string) => `2026-09-${day}T00:00:00.000Z`;

describe('groupProjects (MMR-497)', () => {
  it('splits pinned from the rest, each by most recent activity', () => {
    const list = [
      engineProject({ id: 'OLD', lastActivityAt: new Date(atDay('01')) }),
      engineProject({ id: 'PINOLD', lastActivityAt: new Date(atDay('02')), pinned: true }),
      engineProject({ id: 'NEW', lastActivityAt: new Date(atDay('09')) }),
      engineProject({ id: 'PINNEW', lastActivityAt: new Date(atDay('05')), pinned: true }),
    ];
    const groups = groupProjects(list);
    expect(groups.pinned.map((p) => p.id)).toStrictEqual(['PINNEW', 'PINOLD']);
    expect(groups.rest.map((p) => p.id)).toStrictEqual(['NEW', 'OLD']);
  });

  it('leaves archived projects out of both groups', () => {
    const groups = groupProjects([
      engineProject({ archivedAt: new Date(atDay('01')), id: 'ARC' }),
      engineProject({ id: 'LIVE' }),
    ]);
    expect(groups.rest.map((p) => p.id)).toStrictEqual(['LIVE']);
    expect(groups.pinned).toStrictEqual([]);
  });
});

const ids = (list: readonly { id: string }[]) => list.map((p) => p.id);

const recent = (id: string, day: string, pinned = false) =>
  engineProject({ id, lastActivityAt: new Date(atDay(day)), pinned });

describe('homeShortlist (MMR-730)', () => {
  it('lists every project when there are six or fewer, pinned first, then by activity', () => {
    const list = [recent('A', '01'), recent('B', '05', true), recent('C', '09')];
    expect(ids(homeShortlist(list, new Map()))).toStrictEqual(['B', 'C', 'A']);
  });

  it('leads with the projects that need you, most first, ties in the switcher’s order', () => {
    const list = [
      recent('A', '01'),
      recent('B', '05', true),
      recent('C', '09'),
      recent('D', '03'),
      recent('E', '02'),
    ];
    const needs = new Map([
      ['A', 1],
      ['D', 3],
      ['C', 1],
    ]);
    expect(ids(homeShortlist(list, needs))).toStrictEqual(['D', 'C', 'A', 'B', 'E']);
  });

  it('stops at six rows: need you, then pinned, then the most recently active', () => {
    const list = [
      recent('P1', '01', true),
      recent('P2', '02', true),
      ...['10', '11', '12', '13', '14', '15'].map((day) => recent(`R${day}`, day)),
    ];
    const needs = new Map([['R10', 2]]);
    expect(ids(homeShortlist(list, needs))).toStrictEqual(['R10', 'P2', 'P1', 'R15', 'R14', 'R13']);
  });

  it('leaves archived projects out', () => {
    const list = [
      engineProject({ archivedAt: new Date(atDay('01')), id: 'ARC' }),
      recent('A', '02'),
    ];
    expect(ids(homeShortlist(list, new Map([['ARC', 4]])))).toStrictEqual(['A']);
  });
});

describe('filterProjects', () => {
  const list = [
    engineProject({ id: 'NORN', title: 'Vault engine' }),
    engineProject({ id: 'MMR', title: 'Mimir' }),
    engineProject({ id: 'LM', title: 'Lumen' }),
  ];

  it('matches the key or the title, ignoring case and surrounding space', () => {
    expect(filterProjects(list, ' mim ').map((p) => p.id)).toStrictEqual(['MMR']);
    expect(filterProjects(list, 'nor').map((p) => p.id)).toStrictEqual(['NORN']);
    expect(filterProjects(list, 'engine').map((p) => p.id)).toStrictEqual(['NORN']);
  });

  it('keeps everything for an empty query', () => {
    expect(filterProjects(list, '  ')).toHaveLength(3);
  });
});

describe('projectSwitchTarget', () => {
  it.each([
    ['/p/A', '/p/$key'],
    ['/p/A/tasks', '/p/$key/tasks'],
    ['/p/A/seeds', '/p/$key/seeds'],
    ['/p/A/artifacts', '/p/$key/artifacts'],
  ])('%s keeps its section: %s', (pathname, to) => {
    expect(projectSwitchTarget(pathname, 'B')).toStrictEqual({ params: { key: 'B' }, to });
  });

  it.each(['/p/A/417', '/p/A/s4', '/p/A/a9', '/', '/doctor'])(
    '%s lands on the new project’s work page',
    (pathname) => {
      expect(projectSwitchTarget(pathname, 'B')).toStrictEqual({
        params: { key: 'B' },
        to: '/p/$key',
      });
    },
  );
});

describe('overlayPins', () => {
  it('sets the pin each pending write is heading for and leaves the others', () => {
    const list = [
      engineProject({ id: 'A', pinned: false }),
      engineProject({ id: 'B', pinned: true }),
      engineProject({ id: 'C', pinned: false }),
    ];
    const shown = overlayPins(
      list,
      new Map([
        ['A', true],
        ['B', false],
      ]),
    );
    expect(shown.map((p) => [p.id, p.pinned])).toStrictEqual([
      ['A', true],
      ['B', false],
      ['C', false],
    ]);
    expect(list[0]?.pinned).toBe(false);
  });
});
