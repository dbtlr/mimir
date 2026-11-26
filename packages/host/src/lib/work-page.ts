import type { EngineNode, EngineTree } from '@mimir/contract';

import { ancestorsOf, subtreeOf } from './ancestry';

/*
 * The pure derivations the work page's records share (ADR 0013, MMR-467
 * refinement): the calendar day of an instant in a zone, a finish's time, the
 * outline of initiatives and phases the shell's sidebar shows, and a record's
 * newest artifacts. The scoped Work tab's own are in `scoped-work.ts`.
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

/** What an outline row shows beside its title. */
export type OutlineTally =
  | { kind: 'counts'; done: number; total: number }
  | { kind: 'open_ended' }
  | { kind: 'parked' }
  | { kind: 'none' };

/**
 * Where an outline row sits against the open record: the record itself, or a
 * container above it.
 */
export type OutlineMark = 'current' | 'path';

/** One initiative or phase in the outline, at its nesting depth; or the open task. */
export type OutlineEntry = {
  id: string;
  title: string;
  status: EngineTree['status'];
  depth: number;
  tally: OutlineTally;
  mark?: OutlineMark;
};

/**
 * A finished top-level initiative in the fold: its own row, and the rows
 * inside it, which the sidebar shows only when the initiative is opened.
 * `holdsOpen` says the open record is the initiative or sits inside it.
 */
export type FinishedInitiative = {
  row: OutlineEntry;
  inside: OutlineEntry[];
  holdsOpen: boolean;
};

export type ProjectOutline = {
  /** Live top-level containers and everything under them, in tree order. */
  entries: OutlineEntry[];
  /** Finished top-level initiatives, folded apart from the live outline, in tree order. */
  finished: FinishedInitiative[];
};

const isContainer = (node: EngineTree): boolean => node.type !== 'task';

/** A finished initiative: done or abandoned. */
const isFinished = (node: EngineTree): boolean =>
  node.type === 'initiative' && (node.status === 'done' || node.status === 'abandoned');

/**
 * Done over total across a node's direct children, tasks and containers alike.
 * An abandoned child is out of the total, so a finished container reads N/N.
 */
function childTally(node: EngineTree): { done: number; total: number } {
  const counted = node.children.filter((c) => c.status !== 'abandoned');
  return { done: counted.filter((c) => c.status === 'done').length, total: counted.length };
}

function tallyOf(node: EngineTree): OutlineTally {
  if (node.open_ended === true) {
    return { kind: 'open_ended' };
  }
  if (node.status === 'parked') {
    return { kind: 'parked' };
  }
  return { kind: 'counts', ...childTally(node) };
}

/** The open record and the containers above it. */
type Place = { currentId: string; pathIds: ReadonlySet<string> };

function markOf(id: string, place: Place | undefined): OutlineMark | undefined {
  if (place === undefined) {
    return undefined;
  }
  if (id === place.currentId) {
    return 'current';
  }
  return place.pathIds.has(id) ? 'path' : undefined;
}

/** A container and the containers under it, flattened in tree order. */
function flatten(node: EngineTree, depth: number, place: Place | undefined): OutlineEntry[] {
  return [
    {
      depth,
      id: node.id,
      mark: markOf(node.id, place),
      status: node.status,
      tally: tallyOf(node),
      title: node.title,
    },
    ...node.children.filter(isContainer).flatMap((c) => flatten(c, depth + 1, place)),
  ];
}

/**
 * The open task as a leaf row just under its nearest container, or first when
 * the project itself holds it. Unchanged when the container is not in `entries`.
 */
function withTaskRow(
  entries: OutlineEntry[],
  task: EngineTree,
  parentId: string | undefined,
): OutlineEntry[] {
  const at = parentId === undefined ? -1 : entries.findIndex((e) => e.id === parentId);
  if (parentId !== undefined && at === -1) {
    return entries;
  }
  const row: OutlineEntry = {
    depth: at === -1 ? 0 : (entries[at]?.depth ?? 0) + 1,
    id: task.id,
    mark: 'current',
    status: task.status,
    tally: { kind: 'none' },
    title: task.title,
  };
  return entries.toSpliced(at + 1, 0, row);
}

/**
 * The outline of a project tree: its initiatives and phases, never its tasks. A
 * top-level initiative that is finished (done or abandoned) folds apart from the
 * rest; a finished phase deeper down stays in place, so the live work reads in
 * context.
 *
 * With `openId`, the outline marks where that record sits: its own row is
 * `current` and the containers above it are `path`. A task is not an outline
 * row by nature, so the open one is listed under its nearest container.
 */
export function buildOutline(tree: EngineTree, openId?: string): ProjectOutline {
  const above = openId === undefined ? undefined : ancestorsOf(tree, openId);
  const open = openId === undefined ? undefined : subtreeOf(tree, openId);
  const place: Place | undefined =
    above === undefined || openId === undefined
      ? undefined
      : { currentId: openId, pathIds: new Set(above.map((a) => a.id)) };
  const top = tree.children.filter(isContainer);
  const finishedTop = top.filter(isFinished);
  let entries = top.filter((n) => !isFinished(n)).flatMap((n) => flatten(n, 0, place));
  let folded = finishedTop.flatMap((n) => flatten(n, 0, place));
  if (open !== undefined && !isContainer(open)) {
    const parentId = above?.at(-1)?.id;
    if (folded.some((e) => e.id === parentId)) {
      folded = withTaskRow(folded, open, parentId);
    } else {
      entries = withTaskRow(entries, open, parentId);
    }
  }
  return { entries, finished: groupByInitiative(folded) };
}

/** Split the fold's flat rows at each top-level row, one group per finished initiative. */
function groupByInitiative(rows: OutlineEntry[]): FinishedInitiative[] {
  const groups: FinishedInitiative[] = [];
  for (const row of rows) {
    const group = groups.at(-1);
    if (row.depth === 0 || group === undefined) {
      groups.push({ holdsOpen: row.mark !== undefined, inside: [], row });
    } else {
      group.inside.push(row);
      group.holdsOpen ||= row.mark !== undefined;
    }
  }
  return groups;
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
