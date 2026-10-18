import { useQueryClient } from '@tanstack/react-query';

/*
 * What every area's writes share: the read keys a write stales and the
 * invalidation that refreshes them. Each area keeps its write hooks in its own
 * module beside this one (`shell-mutations.ts`, `node-mutations.ts`,
 * `seed-mutations.ts`), so work on one area never edits another's file.
 */

/** Every read key a write can stale. Broad invalidation is fine — the server is loopback. */
const WRITE_KEYS: readonly (readonly string[])[] = [
  ['node'],
  ['nodes'],
  ['projects'],
  ['project'],
  ['review'],
  ['seeds'],
  ['tree'],
];

/**
 * Invalidate every read a write can stale. The returned promise settles once
 * the refetches land — most callers fire and forget (`void invalidate()`),
 * while a surface that must not show the value it just replaced returns it
 * from `onSettled` so the mutation stays pending until the record is fresh.
 */
export function useInvalidateOnWrite(): () => Promise<void> {
  const qc = useQueryClient();
  return async () => {
    await Promise.all(WRITE_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })));
  };
}

/** park/block/abandon/return/reopen carry a trimmed reason; plain verbs send no body. */
export function reasonBody(reason?: string): { reason: string } | undefined {
  const trimmed = reason?.trim();
  return trimmed !== undefined && trimmed !== '' ? { reason: trimmed } : undefined;
}
