import { z } from 'zod';

export const snapshotSchema = z.object({
  capturedAt: z.iso.datetime(),
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  pgDumpVersion: z.string().regex(/^18(?:\.[0-9]+)*$/),
  postgresVersion: z.string().regex(/^18(?:\.[0-9]+)*$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.literal(1),
});

export function latestSnapshot(
  snapshots: z.infer<typeof snapshotSchema>[],
): z.infer<typeof snapshotSchema> {
  const selected = snapshots.toSorted((a, b) => {
    const milliseconds = Date.parse(b.capturedAt) - Date.parse(a.capturedAt);
    if (milliseconds) {
      return milliseconds;
    }
    // Date.parse truncates fractions to milliseconds; preserve all accepted precision.
    const aFraction = a.capturedAt.split('.')[1]?.slice(0, -1) ?? '';
    const bFraction = b.capturedAt.split('.')[1]?.slice(0, -1) ?? '';
    const width = Math.max(aFraction.length, bFraction.length);
    const left = aFraction.padEnd(width, '0');
    const right = bFraction.padEnd(width, '0');
    if (left !== right) {
      return left < right ? 1 : -1;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? -1 : 1;
  })[0];
  if (!selected) {
    throw new Error('No snapshots available');
  }
  return selected;
}
