import type { StatusWord } from '@mimir/contract';

import type { ReviewReport } from '../api/view-queries';
import type { Instant } from '../lib/time';
import { entryLabel, entryName, groupEntryLabel } from './decisions-entry';
import type { EntrySet } from './decisions-entry';

/*
 * The Needs you deck's cards from the review report (ADR 0019, MMR-721
 * refinement: "One order, bundled", "The cards", and "Where each field comes
 * from"), as plain data: the deck's view adds the leads, links, and actions.
 * One ranked order across projects, from the report's `queue`; a delivery's
 * provisional decisions make one card, and a project's decisions without a
 * delivery make another, each at its first decision's place.
 */

type NeedsYouRow = ReviewReport['needsYou'][number]['rows'][number];
type DecisionRow = Extract<NeedsYouRow, { kind: 'decision' }>;
type DeliveryRow = Extract<NeedsYouRow, { kind: 'delivery' }>;
type TaskRow = Extract<NeedsYouRow, { kind: 'task' }>;
type Facts = ReviewReport['needsYouFacts'];

/**
 * What a card leads with: an attention dot and a word, or the task's status
 * badge. A question leads with _Question_, which says why it is here, so its
 * card carries no _Needs answers_ chip (MMR-752).
 */
export type NeedsYouLead =
  | { kind: 'attention'; word: 'Decisions' | 'Question' | 'Stopped' }
  | { kind: 'status'; status: StatusWord };

/** Where the preview's Open leads. */
export type NeedsYouOpen =
  | { kind: 'delivery'; id: string }
  | { kind: 'project'; key: string }
  | { kind: 'task'; id: string };

/** A preview fact: a sentence or name, or records listed by ID alone. */
export type NeedsYouFact = { label: string; text: string } | { label: string; ids: string[] };

/** A card's one action, by what it does. */
export type NeedsYouAction =
  | { kind: 'review'; set: EntrySet; label: string; name: string }
  | { kind: 'clear-stop'; delivery: string; label: string; name: string }
  | { kind: 'answer'; task: string; question: string | null; label: string; name: string };

/** One card of the deck and its preview. */
export type NeedsYouCard = {
  /** The card's identity: a task's or stopped delivery's ID, or a bundle's set (`entryName`). */
  key: string;
  lead: NeedsYouLead;
  /** The ID on the status line: the record's, a delivery's for its bundle, or a project's key. */
  id: string;
  /** The project's name after the ID; a project missing from the report shows its key. */
  project?: string;
  /** The project's key, which the Needs you page groups the cards by (MMR-723). */
  projectKey: string;
  /** The records in the set the card holds: one, or a bundle's decisions. */
  records: number;
  /** The IDs of the needs-you records the card holds, as the queue names them: its own, or a bundle's decisions. */
  members: string[];
  title: string;
  detail?: string;
  /** The instant the card's age counts from. */
  at: Instant;
  action?: NeedsYouAction;
  preview: {
    /** The reason the item is here: an optional lead sentence set in 600, then plain text. */
    reason: { strong?: string; text?: string };
    /** Text after the reason, in its own paragraph. */
    text?: string;
    facts: NeedsYouFact[];
    open: NeedsYouOpen;
  };
};

/** A bundle as the walk gathers it: its set, its decisions' count and IDs, and its first decision's instant. */
type Bundle = { set: EntrySet; count: number; ids: string[]; at: Instant };

/** "N things", in the singular for one. */
function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The reason's first sentence and the rest, for a stopped delivery's preview. */
export function firstSentence(text: string): { first: string; rest?: string } {
  const match = /^(.+?[.!?])\s+(\S[\s\S]*)$/u.exec(text.trim());
  return match?.[1] === undefined || match[2] === undefined
    ? { first: text.trim() }
    : { first: match[1], rest: match[2] };
}

/** The decisions' card fields both kinds of bundle share: the detail's count, Tasks, and the button. */
function bundleCount(bundle: Bundle, facts: Facts) {
  const tasks =
    facts.bundles.find((each) => entryName(each.set) === entryName(bundle.set))?.tasks ?? [];
  const detail =
    tasks.length === 0
      ? `No work is built on ${bundle.count === 1 ? 'it' : 'them'} yet.`
      : `Across ${counted(tasks.length, 'task', 'tasks')}.`;
  const taskFacts: NeedsYouFact[] = tasks.length === 0 ? [] : [{ ids: tasks, label: 'Tasks' }];
  return { detail, label: entryLabel(bundle.count), taskFacts };
}

/** A phase by its title, or its ID when no title is available. */
function phaseFact(phase: { id: string; title: string | null }): NeedsYouFact {
  return { label: 'Phase', text: phase.title ?? phase.id };
}

function deliveryBundle(
  bundle: Bundle & { set: { kind: 'delivery' } },
  { facts, project, projectKey }: { facts: Facts; project: string; projectKey: string },
): NeedsYouCard {
  const { id } = bundle.set;
  const entry = facts.deliveries.find((each) => each.id === id);
  const { detail, label, taskFacts } = bundleCount(bundle, facts);
  return {
    action: { kind: 'review', label, name: groupEntryLabel(bundle), set: bundle.set },
    at: bundle.at,
    detail,
    id,
    key: entryName(bundle.set),
    lead: { kind: 'attention', word: 'Decisions' },
    members: bundle.ids,
    preview: {
      facts: entry === undefined ? taskFacts : [...taskFacts, phaseFact(entry.phase)],
      open: { id, kind: 'delivery' },
      reason: {
        text: `This delivery has ${counted(bundle.count, 'provisional decision', 'provisional decisions')}.`,
      },
    },
    project,
    projectKey,
    records: bundle.count,
    title: entry?.title ?? `Decisions on ${id}`,
  };
}

function projectBundle(
  bundle: Bundle & { set: { kind: 'project' } },
  { facts, name }: { facts: Facts; name: string | undefined },
): NeedsYouCard {
  const { key } = bundle.set;
  const { detail, label, taskFacts } = bundleCount(bundle, facts);
  return {
    action: {
      kind: 'review',
      label,
      name: `${groupEntryLabel(bundle)} in ${key}`,
      set: bundle.set,
    },
    at: bundle.at,
    detail,
    id: key,
    key: entryName(bundle.set),
    lead: { kind: 'attention', word: 'Decisions' },
    members: bundle.ids,
    preview: {
      facts: taskFacts,
      open: { key, kind: 'project' },
      reason: {
        text: `This project has ${counted(bundle.count, 'provisional decision', 'provisional decisions')} without a delivery.`,
      },
    },
    project: name,
    projectKey: key,
    records: bundle.count,
    title: `${name ?? key} decisions without a delivery`,
  };
}

function stoppedDelivery(
  { delivery }: DeliveryRow,
  {
    facts,
    project,
    projectKey,
    waiting,
  }: { facts: Facts; project: string; projectKey: string; waiting: number },
): NeedsYouCard {
  const reason = delivery.hold_reason?.trim() ?? '';
  const split = reason === '' ? undefined : firstSentence(reason);
  const phase = facts.deliveries.find((each) => each.id === delivery.id)?.phase ?? {
    id: delivery.phase,
    title: null,
  };
  const decisions: NeedsYouFact[] =
    waiting === 0
      ? []
      : [
          {
            label: 'Decisions',
            text:
              waiting === 1
                ? '1 decision on this delivery is waiting. It is its own card in Needs you.'
                : `${String(waiting)} decisions on this delivery are waiting. They are their own card in Needs you.`,
          },
        ];
  return {
    action: {
      delivery: delivery.id,
      kind: 'clear-stop',
      label: 'Clear stop',
      name: `Clear stop on ${delivery.id}`,
    },
    at: delivery.updated_at,
    detail: reason === '' ? undefined : reason,
    id: delivery.id,
    key: delivery.id,
    lead: { kind: 'attention', word: 'Stopped' },
    members: [delivery.id],
    preview: {
      facts: [...decisions, phaseFact(phase)],
      open: { id: delivery.id, kind: 'delivery' },
      reason: { text: split?.first ?? 'This delivery is stopped.' },
      ...(split?.rest === undefined ? {} : { text: split.rest }),
    },
    project,
    projectKey,
    records: 1,
    title: delivery.title,
  };
}

/** A task's facts: its parent by ID, its size, and its priority, each when it has one. */
function factsOfTask(task: TaskRow['task']): NeedsYouFact[] {
  return [
    ...(task.parent === null ? [] : [{ ids: [task.parent], label: 'Parent' }]),
    ...(task.size === undefined || task.size === null
      ? []
      : [{ label: 'Size', text: `${task.size.charAt(0).toUpperCase()}${task.size.slice(1)}` }]),
    ...(task.priority === undefined || task.priority === null
      ? []
      : [{ label: 'Priority', text: task.priority }]),
  ];
}

function taskCard(
  row: TaskRow,
  { project, projectKey }: { project: string; projectKey: string },
): NeedsYouCard {
  const { task } = row;
  const asks = row.reason === 'needs_answers';
  const said = asks ? row.question : (task.holdReason ?? null);
  const detail = said === null || said.trim() === '' ? undefined : said;
  return {
    ...(asks
      ? {
          action: {
            kind: 'answer' as const,
            label: 'Answer…',
            name: `Answer ${task.id}`,
            question: row.question,
            task: task.id,
          },
        }
      : {}),
    at: task.updatedAt,
    detail,
    id: task.id,
    key: task.id,
    lead: asks ? { kind: 'attention', word: 'Question' } : { kind: 'status', status: task.status },
    members: [task.id],
    preview: {
      facts: factsOfTask(task),
      open: { id: task.id, kind: 'task' },
      reason: {
        strong: asks ? 'Needs an answer before it can start.' : 'Blocked on you.',
        ...(detail === undefined ? {} : { text: detail }),
      },
    },
    project,
    projectKey,
    records: 1,
    title: task.title,
  };
}

/** A row's record ID, as the queue names it; `needsYouId` would import the server reads into the deck. */
function rowId(row: NeedsYouRow): string {
  switch (row.kind) {
    case 'task': {
      return row.task.id;
    }
    case 'decision': {
      return row.decision.id;
    }
    case 'delivery': {
      return row.delivery.id;
    }
    default: {
      const unexpected: never = row;
      return unexpected;
    }
  }
}

/** The set a decision row belongs to: its delivery's, or its project's decisions without one. */
function setOf({ decision }: DecisionRow): EntrySet {
  return decision.delivery === null
    ? { key: decision.project_key, kind: 'project' }
    : { id: decision.delivery, kind: 'delivery' };
}

type Placed =
  | { kind: 'row'; row: DeliveryRow | TaskRow; project: string }
  | { kind: 'bundle'; bundle: Bundle; project: string };

/**
 * The deck's cards in the needs-you set's one order across projects. Each
 * member's row comes from its project's `needsYou` group; a queue member with
 * no row is skipped.
 */
export function needsYouCards(report: ReviewReport): NeedsYouCard[] {
  const rows = new Map<string, { row: NeedsYouRow; project: string }>();
  for (const group of report.needsYou) {
    for (const row of group.rows) {
      rows.set(`${row.kind}:${rowId(row)}`, { project: group.project.key, row });
    }
  }
  const names = new Map(report.projects.map((project) => [project.key, project.name]));

  const placed: Placed[] = [];
  const bundles = new Map<string, Bundle>();
  for (const member of report.queue) {
    const found = rows.get(`${member.kind}:${member.id}`);
    if (found === undefined) {
      continue;
    }
    const { row, project } = found;
    if (row.kind !== 'decision') {
      placed.push({ kind: 'row', project, row });
      continue;
    }
    const set = setOf(row);
    const held = bundles.get(entryName(set));
    if (held === undefined) {
      const bundle = { at: row.decision.created_at, count: 1, ids: [row.decision.id], set };
      bundles.set(entryName(set), bundle);
      placed.push({ bundle, kind: 'bundle', project });
    } else {
      held.count += 1;
      held.ids.push(row.decision.id);
    }
  }

  const facts = report.needsYouFacts;
  return placed.map((each) => {
    const name = names.get(each.project);
    const project = name ?? each.project;
    if (each.kind === 'bundle') {
      const { bundle } = each;
      const { set } = bundle;
      return set.kind === 'delivery'
        ? deliveryBundle({ ...bundle, set }, { facts, project, projectKey: each.project })
        : projectBundle({ ...bundle, set }, { facts, name });
    }
    const { row } = each;
    if (row.kind === 'delivery') {
      const waiting = bundles.get(entryName({ id: row.delivery.id, kind: 'delivery' }))?.count ?? 0;
      return stoppedDelivery(row, { facts, project, projectKey: each.project, waiting });
    }
    return taskCard(row, { project, projectKey: each.project });
  });
}

/** One project's cards on the Needs you page, in the set's order, and the records they hold. */
export type NeedsYouSection = {
  key: string;
  /** The project's name; a project missing from the report's `projects` shows its key. */
  name: string;
  cards: NeedsYouCard[];
  records: number;
};

/**
 * The Needs you page's sections (ADR 0019, MMR-723 refinement: The list):
 * one per project, placed at its first card's place in the set's one order,
 * its cards following in that order. A project with no card has no section.
 */
export function needsYouSections(report: ReviewReport): NeedsYouSection[] {
  const names = new Map(report.projects.map((project) => [project.key, project.name]));
  const sections = new Map<string, NeedsYouSection>();
  for (const card of needsYouCards(report)) {
    const held = sections.get(card.projectKey);
    if (held === undefined) {
      sections.set(card.projectKey, {
        cards: [card],
        key: card.projectKey,
        name: names.get(card.projectKey) ?? card.projectKey,
        records: card.records,
      });
    } else {
      held.cards.push(card);
      held.records += card.records;
    }
  }
  return [...sections.values()];
}
