import { describe, expect, it } from 'vitest';

import {
  isSectionPage,
  openRecordId,
  sectionOfPath,
  sidebarContextOf,
} from '../lib/project-sidebar';

describe('sectionOfPath', () => {
  it.each([
    ['/p/MMR', undefined, 'work'],
    ['/p/MMR/tasks', undefined, 'tasks'],
    ['/p/MMR/seeds', undefined, 'seeds'],
    ['/p/MMR/artifacts', undefined, 'artifacts'],
    ['/p/MMR/s41', undefined, 'seeds'],
    ['/p/MMR/a219', undefined, 'artifacts'],
    ['/p/MMR/417', 'task', 'tasks'],
    ['/p/MMR/417', 'phase', 'work'],
    ['/p/MMR/417', 'initiative', 'work'],
    ['/p/MMR/417', undefined, 'work'],
  ] as const)('%s (%s) is in %s', (path, type, section) => {
    expect(sectionOfPath(path, type)).toBe(section);
  });

  it.each(['/', '/doctor', '/nowhere'])('%s is in none', (path) => {
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

describe('openRecordId', () => {
  it('names the node a record path opens', () => {
    expect(openRecordId('/p/MMR/417')).toBe('MMR-417');
  });

  it.each(['/', '/p/MMR', '/p/MMR/tasks', '/p/MMR/s41', '/p/MMR/a2'])(
    '%s opens no node',
    (path) => {
      expect(openRecordId(path)).toBeUndefined();
    },
  );
});

describe('sidebarContextOf (MMR-505)', () => {
  it.each(['/p/MMR', '/p/MMR/tasks', '/p/MMR/417'])('%s frames its project', (path) => {
    expect(sidebarContextOf(path)).toStrictEqual({ key: 'MMR', kind: 'project' });
  });

  it.each(['/', '/doctor', '/tasks', '/nowhere'])('%s frames All projects', (path) => {
    expect(sidebarContextOf(path)).toStrictEqual({ kind: 'all' });
  });
});
