import { NODE_TYPE_VALUES } from '@mimir/contract';
import { useEffect } from 'react';
import { z } from 'zod';

/**
 * The records this browser opened most recently (MMR-455), newest first: the
 * jump palette lists them before anything is typed. Kept in localStorage, per
 * browser, like the theme pick; a record page and a palette pick both count.
 */

const STORAGE_KEY = 'mimir-recent-records';
const RECENT_LIMIT = 5;

const recentSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.enum([...NODE_TYPE_VALUES, 'project', 'seed', 'artifact']),
    project: z.string(),
    title: z.string(),
  }),
);

export type RecentRecord = z.infer<typeof recentSchema>[number];

/** The remembered records, newest first; none when storage is empty, unreadable, or corrupt. */
export function readRecentRecords(): RecentRecord[] {
  try {
    const parsed = recentSchema.safeParse(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Put a record at the front of the list, dropping its older entry and the oldest overflow. */
export function rememberRecord(record: RecentRecord): void {
  const rest = readRecentRecords().filter((r) => r.id !== record.id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([record, ...rest].slice(0, RECENT_LIMIT)));
  } catch {
    // private mode / storage disabled — the record just isn't remembered
  }
}

/** Remember a record page's record once it has loaded, and again when its title changes. */
export function useRememberRecord(record: RecentRecord | undefined): void {
  const { id, kind, project, title } = record ?? {};
  useEffect(() => {
    if (id !== undefined && kind !== undefined && project !== undefined && title !== undefined) {
      rememberRecord({ id, kind, project, title });
    }
  }, [id, kind, project, title]);
}
