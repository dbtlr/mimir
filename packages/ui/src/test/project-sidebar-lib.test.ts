import { describe, expect, it } from 'vitest';

import { openRecordId, sectionOfPath } from '../lib/project-sidebar';

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
