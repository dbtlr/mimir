import type { ConsoleOutput } from '@mimir/contract';

/*
 * The notifier's event building (ADR 0045): a member of the needs-you set
 * becomes an event kind, a text, and a target. Pure apart from the one
 * delivery-title read a decisions title may ask for.
 */

export type NotificationKind =
  | 'delivery_stopped'
  | 'decisions'
  | 'task_blocked'
  | 'task_needs_answers';

/** One notification event: what a channel receives. */
export type NotificationEvent = {
  body: string;
  ids: string[];
  kind: NotificationKind;
  /** The size of the needs-you set at the check that emitted the event. */
  needs_you: number;
  project: string;
  /** The console path that opens the record. */
  target: string;
  title: string;
};

export type ReviewRead = ConsoleOutput<'review'>;
export type QueueEntry = ReviewRead['queue'][number];
type NeedsYouRow = ReviewRead['needsYou'][number]['rows'][number];

/** The UTF-16 range of the first half of a surrogate pair. */
const HIGH_SURROGATE_MIN = 55_296;
const HIGH_SURROGATE_MAX = 56_319;

export const TITLE_LIMIT = 100;
export const BODY_LIMIT = 240;

/** The identity of a member: its kind and its record's id. */
export const entryKey = (entry: QueueEntry): string => `${entry.kind}:${entry.id}`;

/** Collapse whitespace runs to one space, then cut a text over `limit` so it ends in an ellipsis inside it. */
export function plainText(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) {
    return flat;
  }
  let end = limit - 1;
  const last = flat.charCodeAt(end - 1);
  if (last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX) {
    end -= 1; // never leave half of a surrogate pair
  }
  return `${flat.slice(0, end).trimEnd()}…`;
}

/** The text of a record's own words, or `fallback` when it has none. */
const orFallback = (text: string | null | undefined, fallback: string): string =>
  (text ?? '').trim() === '' ? fallback : text!;

const trailingNumber = (id: string, marker: RegExp): string | null => marker.exec(id)?.[1] ?? null;

/** The task's sequence number in its path: `MMR-708` is `708`. */
const taskSeq = (id: string): string => trailingNumber(id, /-(\d+)$/) ?? id;

type Located = { project: string; row: NeedsYouRow };

function rowId(row: NeedsYouRow): string {
  if (row.kind === 'task') {
    return row.task.id;
  }
  return row.kind === 'decision' ? row.decision.id : row.delivery.id;
}

function locate(review: ReviewRead): Map<string, Located> {
  const found = new Map<string, Located>();
  for (const group of review.needsYou) {
    for (const row of group.rows) {
      const id = rowId(row);
      found.set(entryKey({ id, kind: row.kind }), { project: group.project.key, row });
    }
  }
  return found;
}

type Draft = { event: NotificationEvent } | { decisions: DecisionGroup; event: NotificationEvent };

type DecisionGroup = {
  delivery: string | null;
  members: string[];
  project: string;
  question: string;
};

function singleEvent(
  project: string,
  row: Exclude<NeedsYouRow, { kind: 'decision' }>,
  needsYou: number,
): NotificationEvent {
  const base = { needs_you: needsYou, project };
  if (row.kind === 'delivery') {
    const { delivery } = row;
    return {
      ...base,
      body: plainText(orFallback(delivery.hold_reason, delivery.id), BODY_LIMIT),
      ids: [delivery.id],
      kind: 'delivery_stopped',
      target: `/p/${project}/d${delivery.seq}`,
      title: plainText(orFallback(delivery.title, delivery.id), TITLE_LIMIT),
    };
  }
  const { task } = row;
  const blocked = row.reason === 'blocked';
  return {
    ...base,
    body: plainText(orFallback(blocked ? task.holdReason : row.question, task.id), BODY_LIMIT),
    ids: [task.id],
    kind: blocked ? 'task_blocked' : 'task_needs_answers',
    target: `/p/${project}/${taskSeq(task.id)}`,
    title: plainText(orFallback(task.title, task.id), TITLE_LIMIT),
  };
}

/**
 * Events for the entries, in the order given (the review's `queue` order). The
 * decision entries naming one delivery form one event, and those naming none
 * form one event per project; a decisions event takes the place of its first
 * member. An entry with no row in the read is skipped.
 */
export async function buildEvents(
  entries: QueueEntry[],
  review: ReviewRead,
  readDeliveryTitle: (id: string) => Promise<string>,
): Promise<NotificationEvent[]> {
  const rows = locate(review);
  const needsYou = review.queue.length;
  const drafts: Draft[] = [];
  const groups = new Map<string, DecisionGroup>();
  for (const entry of entries) {
    const located = rows.get(entryKey(entry));
    if (located === undefined) {
      continue;
    }
    const { row } = located;
    if (row.kind !== 'decision') {
      drafts.push({ event: singleEvent(located.project, row, needsYou) });
      continue;
    }
    const { decision } = row;
    const groupKey = decision.delivery ?? `project:${located.project}`;
    const group = groups.get(groupKey);
    if (group !== undefined) {
      group.members.push(decision.id);
      continue;
    }
    const created: DecisionGroup = {
      delivery: decision.delivery,
      members: [decision.id],
      project: located.project,
      question: decision.question,
    };
    groups.set(groupKey, created);
    drafts.push({
      decisions: created,
      event: {
        body: '',
        ids: [],
        kind: 'decisions',
        needs_you: needsYou,
        project: located.project,
        target: '',
        title: '',
      },
    });
  }
  const events: NotificationEvent[] = [];
  for (const draft of drafts) {
    events.push(
      'decisions' in draft ? await decisionsEvent(draft, readDeliveryTitle) : draft.event,
    );
  }
  return events;
}

async function decisionsEvent(
  { decisions, event }: Extract<Draft, { decisions: DecisionGroup }>,
  readDeliveryTitle: (id: string) => Promise<string>,
): Promise<NotificationEvent> {
  const { delivery, members, project, question } = decisions;
  let subject = project;
  let target = `/p/${project}?mode=decisions`;
  if (delivery !== null) {
    subject = await readDeliveryTitle(delivery).catch(() => delivery);
    const seq = trailingNumber(delivery, /-d(\d+)$/);
    if (seq !== null) {
      target = `/p/${project}/d${seq}?mode=decisions`;
    }
  }
  const lead = members.length > 1 ? `${members.length} decisions` : 'Decision';
  return {
    ...event,
    body: plainText(orFallback(question, members[0]!), BODY_LIMIT),
    ids: members,
    target,
    title: plainText(`${lead} on ${orFallback(subject, delivery ?? project)}`, TITLE_LIMIT),
  };
}
