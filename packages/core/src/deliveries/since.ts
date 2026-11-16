import type {
  DeliveryEvent,
  DeliveryFindingRecord,
  DeliveryHistory,
  DeliveryEventKind,
} from '@mimir/contract';

/**
 * The pure half of the since read (ADR 0042, MMR-692): the member spans, the
 * event mapping, the total order, and the settle window. The store hands back
 * the raw rows of every source from one snapshot ({@link SinceSources}); these
 * functions decide which of them are events after the caller's cursor and in
 * what order they read. Nothing here touches a clock or a store.
 */

/** The 5 seconds `as_of` lags the reading process's clock (the glossary's settle window). */
export const SETTLE_WINDOW_MS = 5000;

/**
 * The cursor for the next read: the reading process's clock minus the settle
 * window, and never earlier than `since`, so the cursor does not move backwards.
 */
export function asOf(clock: Date, since: Date): Date {
  return new Date(Math.max(clock.getTime() - SETTLE_WINDOW_MS, since.getTime()));
}

/** A delivery history row with the row id the event id and the tie order use. */
export type SinceHistoryRow = DeliveryHistory & { id: number };

/** A member task's log row of a kind the feed reports (a member cannot be moved; archive rows are project rows). */
export type SinceTransitionRow = {
  id: number;
  node_id: string;
  kind: 'lifecycle' | 'hold' | 'dependency' | 'assignment';
  from_value: string | null;
  to_value: string | null;
  reason: string | null;
  at: string;
};

export type SinceNoteRow = { id: number; task: string; text: string; at: string };

export type SinceItemRow = {
  task: string;
  number: number;
  content: string;
  state: 'open' | 'checked' | 'dropped';
  reason: string | null;
  created_at: string;
  settled_at: string | null;
};

export type SinceDecisionRow = { id: string; question: string; created_at: string };

export type SinceDecisionHistoryRow = {
  id: number;
  decision: string;
  kind: 'lifecycle' | 'link' | 'delivery';
  from_value: string | null;
  to_value: string | null;
  reason: string | null;
  task: string | null;
  at: string;
};

export type SinceJournalRow = { id: string; title: string; created_at: string };

/** Every source of a delivery's feed, read in one snapshot and not yet filtered by time. */
export type SinceSources = {
  /** The delivery the feed is of (`KEY-dN`). */
  delivery: string;
  history: SinceHistoryRow[];
  findings: DeliveryFindingRecord[];
  followUps: { id: number; record: string; linked_at: string; unlinked_at: string | null }[];
  /** Log rows of every task that was ever a member, of the kinds the feed reports. */
  transitions: SinceTransitionRow[];
  notes: SinceNoteRow[];
  items: SinceItemRow[];
  /** Decisions whose `delivery` names this delivery now. */
  decisions: SinceDecisionRow[];
  /** Those decisions' whole history, and any `delivery` row of another decision that names this delivery. */
  decisionHistory: SinceDecisionHistoryRow[];
  journals: SinceJournalRow[];
};

/** One stretch of a task's membership: both ends inclusive, `end` null while it is open. */
export type Span = { start: string; end: string | null };

/**
 * Each task's membership spans. A span starts at a `joined` row and ends at the
 * task's next `left`, `released`, or `abandoned` row. A span that `abandoned`
 * ended runs on to the task's next lifecycle row to `abandoned` at or after the
 * member row, so the abandon and its reason are in the feed; `abandonedAt` holds
 * those instants per task. When the delivery landed, its `landed` lifecycle row
 * ends every span still open. A span still open after that has no upper bound.
 */
export function memberSpans(
  history: readonly SinceHistoryRow[],
  abandonedAt: Readonly<Record<string, readonly string[]>>,
): Map<string, Span[]> {
  // Row ids are the history's order; the caller's order is not relied on.
  const ordered = history.toSorted((a, b) => a.id - b.id);
  const landed = ordered.find((row) => row.kind === 'lifecycle' && row.to_value === 'landed');
  const spans = new Map<string, Span[]>();
  for (const row of ordered) {
    if (row.kind !== 'member' || row.task === null) {
      continue;
    }
    const mine = spans.get(row.task) ?? [];
    spans.set(row.task, mine);
    if (row.to_value === 'joined') {
      mine.push({ end: null, start: row.at });
      continue;
    }
    const open = mine.at(-1);
    if (open === undefined || open.end !== null) {
      continue;
    }
    open.end =
      row.to_value === 'abandoned'
        ? (abandonedAt[row.task]?.toSorted().find((at) => at >= row.at) ?? row.at)
        : row.at;
  }
  if (landed !== undefined) {
    for (const mine of spans.values()) {
      for (const span of mine) {
        span.end ??= landed.at;
      }
    }
  }
  return spans;
}

/** Whether `at` falls in one of `spans`, both ends included. */
export function inSpans(spans: readonly Span[], at: string): boolean {
  return spans.some((span) => at >= span.start && (span.end === null || at <= span.end));
}

/** An event with the two sort keys the tie order needs beyond its own fields. */
export type RankedEvent = DeliveryEvent & {
  /** The source's rank: lower reads first. */
  rank: number;
  /** The row id or number the event came from; null for a kind that has neither. */
  row: number | null;
};

/**
 * The total order of the feed: time, then the source's rank, then `record` as a
 * string, then the row id or number (none first), then `id`. Strings compare by
 * code unit, so the order is the same on every runtime and locale.
 */
export function compareEvents(a: RankedEvent, b: RankedEvent): number {
  return (
    compareText(a.at, b.at) ||
    a.rank - b.rank ||
    compareText(a.record, b.record) ||
    (a.row ?? Number.NEGATIVE_INFINITY) - (b.row ?? Number.NEGATIVE_INFINITY) ||
    compareText(a.id, b.id)
  );
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** The source ranks, first to last (ADR 0042, MMR-692). */
const RANK = {
  decided: 7,
  decisionHistory: 8,
  findings: 2,
  followUps: 3,
  history: 1,
  items: 6,
  journal: 9,
  notes: 5,
  transitions: 4,
} as const;

const NONE = {
  from: null,
  number: null,
  reason: null,
  task: null,
  text: null,
  to: null,
} as const;

type Draft = Omit<RankedEvent, 'from' | 'number' | 'reason' | 'task' | 'text' | 'to'> &
  Partial<Pick<RankedEvent, 'from' | 'number' | 'reason' | 'task' | 'text' | 'to'>>;

const ranked = (draft: Draft): RankedEvent => ({ ...NONE, ...draft });

/** Every event the sources carry, before the cursor is applied. */
function allEvents(sources: SinceSources): RankedEvent[] {
  const delivery = sources.delivery;
  const abandonedAt: Record<string, string[]> = {};
  for (const row of sources.transitions) {
    if (row.kind === 'lifecycle' && row.to_value === 'abandoned') {
      (abandonedAt[row.node_id] ??= []).push(row.at);
    }
  }
  const spans = memberSpans(sources.history, abandonedAt);
  const member = (task: string, at: string): boolean => inSpans(spans.get(task) ?? [], at);
  const current = new Set(sources.decisions.map((decision) => decision.id));
  const events: RankedEvent[] = [];

  for (const row of sources.history) {
    events.push(
      ranked({
        at: row.at,
        from: row.from_value,
        id: `${delivery}/history/${String(row.id)}`,
        kind: row.kind,
        rank: RANK.history,
        reason: row.reason,
        record: delivery,
        row: row.id,
        task: row.task,
        to: row.to_value,
      }),
    );
  }
  for (const entry of sources.findings) {
    events.push(
      ranked({
        at: entry.created_at,
        id: `${delivery}/finding/${String(entry.number)}`,
        kind: entry.kind,
        number: entry.number,
        rank: RANK.findings,
        reason: entry.reason,
        record: delivery,
        row: entry.number,
        text: entry.text,
      }),
    );
  }
  for (const row of sources.followUps) {
    const base = {
      kind: 'follow_up',
      rank: RANK.followUps,
      record: delivery,
      row: row.id,
      text: row.record,
    } as const;
    events.push(
      ranked({
        ...base,
        at: row.linked_at,
        id: `${delivery}/follow-up/${String(row.id)}/linked`,
        to: 'linked',
      }),
    );
    if (row.unlinked_at !== null) {
      events.push(
        ranked({
          ...base,
          at: row.unlinked_at,
          from: 'linked',
          id: `${delivery}/follow-up/${String(row.id)}/unlinked`,
          to: 'unlinked',
        }),
      );
    }
  }
  for (const row of sources.transitions) {
    if (member(row.node_id, row.at)) {
      events.push(
        ranked({
          at: row.at,
          from: row.from_value,
          id: `${row.node_id}/transition/${String(row.id)}`,
          kind: row.kind,
          rank: RANK.transitions,
          reason: row.reason,
          record: row.node_id,
          row: row.id,
          to: row.to_value,
        }),
      );
    }
  }
  for (const row of sources.notes) {
    if (member(row.task, row.at)) {
      events.push(
        ranked({
          at: row.at,
          id: `${row.task}/note/${String(row.id)}`,
          kind: 'note',
          rank: RANK.notes,
          record: row.task,
          row: row.id,
          text: row.text,
        }),
      );
    }
  }
  for (const item of sources.items) {
    const base = {
      kind: 'item',
      number: item.number,
      rank: RANK.items,
      record: item.task,
      row: item.number,
      text: item.content,
    } as const;
    if (member(item.task, item.created_at)) {
      events.push(
        ranked({
          ...base,
          at: item.created_at,
          id: `${item.task}/item/${String(item.number)}/added`,
          to: 'open',
        }),
      );
    }
    if (item.settled_at !== null && member(item.task, item.settled_at)) {
      events.push(
        ranked({
          ...base,
          at: item.settled_at,
          from: 'open',
          id: `${item.task}/item/${String(item.number)}/settled`,
          reason: item.reason,
          to: item.state,
        }),
      );
    }
  }
  for (const decision of sources.decisions) {
    events.push(
      ranked({
        at: decision.created_at,
        id: `${decision.id}/decided`,
        kind: 'decided',
        rank: RANK.decided,
        record: decision.id,
        row: null,
        text: decision.question,
      }),
    );
  }
  for (const row of sources.decisionHistory) {
    // A decision moved away keeps only the delivery rows that name this delivery.
    const names =
      row.kind === 'delivery' && (row.from_value === delivery || row.to_value === delivery);
    if (current.has(row.decision) || names) {
      events.push(
        ranked({
          at: row.at,
          from: row.from_value,
          id: `${row.decision}/history/${String(row.id)}`,
          kind: row.kind satisfies DeliveryEventKind,
          rank: RANK.decisionHistory,
          reason: row.reason,
          record: row.decision,
          row: row.id,
          task: row.task,
          to: row.to_value,
        }),
      );
    }
  }
  for (const artifact of sources.journals) {
    events.push(
      ranked({
        at: artifact.created_at,
        id: `${artifact.id}/journal`,
        kind: 'journal',
        rank: RANK.journal,
        record: artifact.id,
        row: null,
        text: artifact.title,
      }),
    );
  }
  return events;
}

/**
 * The feed: every event of `sources` strictly after `since` (an instant),
 * oldest first in the total order. Instants compare as instants, not as text,
 * so the cursor's spelling never decides the cut. An event stamped later than
 * any clock is included like any other.
 */
export function feedOf(sources: SinceSources, since: string): DeliveryEvent[] {
  const cursor = Date.parse(since);
  return allEvents(sources)
    .filter((event) => Date.parse(event.at) > cursor)
    .toSorted(compareEvents)
    .map(({ rank: _rank, row: _row, ...event }) => event);
}
