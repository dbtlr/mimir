import { describe, expect, it } from 'vitest';

import {
  filterProjects,
  groupProjects,
  overlayPins,
  projectSwitchTarget,
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
