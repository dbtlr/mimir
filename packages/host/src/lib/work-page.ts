import type { EngineNode, EngineTree } from '@mimir/contract';

/*
 * The pure derivations the work page's records share (ADR 0013, MMR-467
 * refinement): the calendar day of an instant in a zone, a finish's time, a
 * container's tally, and a record's newest artifacts. The scoped Work tab's
 * own are in `scoped-work.ts`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** One day formatter per zone: building one per call made a long history's fold pay for every entry. */
const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(zone: string): Intl.DateTimeFormat {
  let format = dayFormats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      month: '2-digit',
      timeZone: zone,
      year: 'numeric',
    });
    dayFormats.set(zone, format);
  }
  return format;
}

/** The calendar day of an instant in `zone`, `YYYY-MM-DD`. */
export function dayOf(at: number, zone: string): string {
  // Built from the parts, not a locale's whole format: ICU has changed en-CA's date pattern before.
  const parts = dayFormat(zone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((each) => each.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The day before a `YYYY-MM-DD` day. */
export function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** The finish time of a Shipped row, 24-hour `HH:MM` in `zone`. */
export function shippedTime(at: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZone: zone,
  }).format(at);
}

/**
 * What a container's sidebar row shows at its right (ADR 0013, MMR-730
 * refinement), decided in this order: open-ended, parked, nothing under it,
 * else done over its direct children.
 */
export type ContainerTally =
  | { kind: 'open_ended' }
  | { kind: 'parked' }
  | { kind: 'empty' }
  | { kind: 'counts'; done: number; total: number };

/** A container's status reads finished when it is done or abandoned. */
export const isFinishedStatus = (status: EngineTree['status']): boolean =>
  status === 'done' || status === 'abandoned';

/**
 * Done over total across a node's direct children, tasks and containers alike.
 * An abandoned child is out of the total, so a finished container reads N/N.
 */
export function childTally(node: EngineTree): { done: number; total: number } {
  const counted = node.children.filter((c) => c.status !== 'abandoned');
  return { done: counted.filter((c) => c.status === 'done').length, total: counted.length };
}

/**
 * A container's tally: ∞ when open-ended, parked when parked, Empty with
 * nothing counted under it, else done over total.
 */
export function tallyOf(node: EngineTree): ContainerTally {
  if (node.open_ended === true) {
    return { kind: 'open_ended' };
  }
  if (node.status === 'parked') {
    return { kind: 'parked' };
  }
  const counts = childTally(node);
  return counts.total === 0 ? { kind: 'empty' } : { kind: 'counts', ...counts };
}

/** The per-project sequence in an artifact id (`MMR-a12` is 12); 0 when the id has none. */
function artifactSeq(id: string): number {
  const match = /-a(\d+)$/.exec(id);
  return match === null ? 0 : Number(match[1]);
}

/** One artifact a record read lists. */
export type RecordArtifact = NonNullable<EngineNode['artifacts']>[number];

/**
 * The `limit` most recently created artifacts, newest first. Equal timestamps
 * break on the higher seq, matching the server list's `created_at desc, seq desc`.
 */
export function newestArtifacts(
  artifacts: readonly RecordArtifact[],
  limit: number,
): RecordArtifact[] {
  return artifacts
    .toSorted(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || artifactSeq(b.id) - artifactSeq(a.id),
    )
    .slice(0, limit);
}
