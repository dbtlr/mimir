import { beforeEach, describe, expect, it } from 'vitest';

import { readRecentRecords, rememberRecord } from '../lib/recent-records';

const record = (id: string) => ({ id, kind: 'task' as const, project: 'MMR', title: `Task ${id}` });

beforeEach(() => {
  localStorage.clear();
});

describe('recent records (MMR-455)', () => {
  it('lists the most recently opened record first', () => {
    rememberRecord(record('MMR-1'));
    rememberRecord(record('MMR-2'));
    expect(readRecentRecords().map((r) => r.id)).toStrictEqual(['MMR-2', 'MMR-1']);
  });

  it('moves a reopened record to the front instead of listing it twice', () => {
    rememberRecord(record('MMR-1'));
    rememberRecord(record('MMR-2'));
    rememberRecord({ ...record('MMR-1'), title: 'Renamed' });
    expect(readRecentRecords()).toStrictEqual([
      { ...record('MMR-1'), title: 'Renamed' },
      record('MMR-2'),
    ]);
  });

  it('keeps only the newest five', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      rememberRecord(record(`MMR-${String(n)}`));
    }
    expect(readRecentRecords().map((r) => r.id)).toStrictEqual([
      'MMR-6',
      'MMR-5',
      'MMR-4',
      'MMR-3',
      'MMR-2',
    ]);
  });

  it('reads a corrupt entry as no history', () => {
    localStorage.setItem('mimir-recent-records', '{not json');
    expect(readRecentRecords()).toStrictEqual([]);
  });
});
