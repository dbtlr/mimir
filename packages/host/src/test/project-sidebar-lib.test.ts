import { describe, expect, it } from 'vitest';

import {
  isSectionPage,
  projectPlaceOf,
  sectionOfPath,
  sidebarContextOf,
} from '../lib/project-sidebar';

describe('sectionOfPath', () => {
  it.each([
    ['/p/MMR', 'work'],
    ['/p/MMR/tasks', 'tasks'],
    ['/p/MMR/seeds', 'seeds'],
    ['/p/MMR/artifacts', 'artifacts'],
    ['/p/MMR/s41', 'seeds'],
    ['/p/MMR/a219', 'artifacts'],
    ['/p/MMR/417', 'work'],
  ] as const)('%s is in %s', (path, section) => {
    expect(sectionOfPath(path)).toBe(section);
  });

  it.each(['/', '/doctor', '/settings/devices', '/pair', '/nowhere'])('%s is in none', (path) => {
    expect(sectionOfPath(path)).toBeUndefined();
  });

  it('ignores a trailing slash', () => {
    expect(sectionOfPath('/p/MMR/tasks/')).toBe('tasks');
  });
});

describe('isSectionPage', () => {
  it.each(['/p/MMR', '/p/MMR/tasks', '/p/MMR/seeds', '/p/MMR/artifacts'])(
    "%s is a section's own page",
    (path) => {
      expect(isSectionPage(path)).toBe(true);
    },
  );

  it.each(['/p/MMR/417', '/p/MMR/s41', '/p/MMR/a219'])('%s is a record inside one', (path) => {
    expect(isSectionPage(path)).toBe(false);
  });
});

describe('projectPlaceOf (MMR-730)', () => {
  it('reads the project’s own page, whatever its tab', () => {
    expect(projectPlaceOf('/p/MMR')).toStrictEqual({ kind: 'project' });
    expect(projectPlaceOf('/p/MMR/')).toStrictEqual({ kind: 'project' });
  });

  it('names the node a record path opens', () => {
    expect(projectPlaceOf('/p/MMR/417')).toStrictEqual({ id: 'MMR-417', kind: 'node' });
  });

  it.each([
    '/p/MMR/tasks',
    '/p/MMR/seeds',
    '/p/MMR/artifacts',
    '/p/MMR/s41',
    '/p/MMR/a2',
    '/p/MMR/d3',
  ])('%s is a page the project holds', (path) => {
    expect(projectPlaceOf(path)).toStrictEqual({ kind: 'held' });
  });

  it.each(['/', '/projects', '/doctor', '/settings'])('%s is in no project', (path) => {
    expect(projectPlaceOf(path)).toBeUndefined();
  });
});

describe('sidebarContextOf (MMR-505)', () => {
  it.each(['/p/MMR', '/p/MMR/tasks', '/p/MMR/417'])('%s frames its project', (path) => {
    expect(sidebarContextOf(path)).toStrictEqual({ key: 'MMR', kind: 'project' });
  });

  it.each(['/', '/doctor', '/devices', '/tasks', '/nowhere', '/settingsish'])(
    '%s frames All projects',
    (path) => {
      expect(sidebarContextOf(path)).toStrictEqual({ kind: 'all' });
    },
  );

  it.each([
    '/settings',
    '/settings/appearance',
    '/settings/devices',
    '/settings/connections',
    '/settings/about',
    '/pair',
  ])('%s frames Settings (MMR-733)', (path) => {
    expect(sidebarContextOf(path)).toStrictEqual({ kind: 'settings' });
  });
});
