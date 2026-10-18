import { beforeEach, describe, expect, it } from 'vitest';

import {
  orderProjects,
  readRememberedProject,
  rememberProject,
  resolveCurrentProjectKey,
} from '../lib/current-project';
import { engineProject } from './engine-fixtures';

beforeEach(() => {
  localStorage.clear();
});

describe('orderProjects (MMR-495)', () => {
  it('keeps the list order when no project carries pin or activity fields', () => {
    const list = [
      engineProject({ id: 'BBB' }),
      engineProject({ id: 'AAA' }),
      engineProject({ id: 'CCC' }),
    ];
    expect(orderProjects(list).map((p) => p.id)).toStrictEqual(['BBB', 'AAA', 'CCC']);
  });

  it('puts pinned projects first, then the rest by most recent activity', () => {
    const list = [
      engineProject({ id: 'OLD', lastActivityAt: new Date('2026-01-01T00:00:00.000Z') }),
      engineProject({ id: 'NEW', lastActivityAt: new Date('2026-09-01T00:00:00.000Z') }),
      engineProject({
        id: 'PIN',
        lastActivityAt: new Date('2026-02-01T00:00:00.000Z'),
        pinned: true,
      }),
    ];
    expect(orderProjects(list).map((p) => p.id)).toStrictEqual(['PIN', 'NEW', 'OLD']);
  });

  it('sorts a project without activity after one with, and keeps ties in list order', () => {
    const list = [
      engineProject({ id: 'NON' }),
      engineProject({ id: 'ACT', lastActivityAt: new Date('2026-01-01T00:00:00.000Z') }),
      engineProject({ id: 'TWO' }),
    ];
    expect(orderProjects(list).map((p) => p.id)).toStrictEqual(['ACT', 'NON', 'TWO']);
  });

  it('drops archived projects and does not mutate its input', () => {
    const list = [
      engineProject({ archivedAt: new Date('2026-05-01T00:00:00.000Z'), id: 'ARC' }),
      engineProject({ id: 'LIV' }),
    ];
    expect(orderProjects(list).map((p) => p.id)).toStrictEqual(['LIV']);
    expect(list.map((p) => p.id)).toStrictEqual(['ARC', 'LIV']);
  });
});

describe('remembered project (MMR-495)', () => {
  it('is absent until a project is remembered', () => {
    expect(readRememberedProject()).toBeUndefined();
  });

  it('round-trips the last remembered key', () => {
    rememberProject('MMR');
    rememberProject('NRN');
    expect(readRememberedProject()).toBe('NRN');
  });
});

describe('resolveCurrentProjectKey (MMR-495)', () => {
  const projects = [engineProject({ id: 'AAA' }), engineProject({ id: 'BBB' })];

  it('prefers the key in the URL, even for a project not in the list', () => {
    expect(resolveCurrentProjectKey({ projects, remembered: 'BBB', urlKey: 'ZZZ' })).toBe('ZZZ');
  });

  it('falls back to the remembered project while it is still active', () => {
    expect(resolveCurrentProjectKey({ projects, remembered: 'BBB' })).toBe('BBB');
  });

  it('skips a remembered project that is gone or archived', () => {
    expect(resolveCurrentProjectKey({ projects, remembered: 'GONE' })).toBe('AAA');
    const archived = [
      engineProject({ archivedAt: new Date('2026-05-01T00:00:00.000Z'), id: 'OLD' }),
      ...projects,
    ];
    expect(resolveCurrentProjectKey({ projects: archived, remembered: 'OLD' })).toBe('AAA');
  });

  it('falls back to the first project in switcher order with no history', () => {
    const ordered = [engineProject({ id: 'AAA' }), engineProject({ id: 'BBB', pinned: true })];
    expect(resolveCurrentProjectKey({ projects: ordered })).toBe('BBB');
  });

  it('trusts the remembered key while the project list has not loaded', () => {
    expect(resolveCurrentProjectKey({ remembered: 'BBB' })).toBe('BBB');
  });

  it('is undefined with no URL key, no history, and no projects', () => {
    expect(resolveCurrentProjectKey({ projects: [] })).toBeUndefined();
    expect(resolveCurrentProjectKey({})).toBeUndefined();
  });
});
