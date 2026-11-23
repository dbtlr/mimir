import { describe, expect, it } from 'vitest';

import type { ReviewReport } from '../api/view-queries';
import { needsYouCards } from '../components/needs-you-deck-model';
import { T0, blocked, decision, hoursAgo, question, report, stopped } from './needs-you-fixtures';
import { needsYouRow } from './views-fixtures';

/*
 * The Needs you deck's cards from the review report (ADR 0019, MMR-721
 * refinement: "One order, bundled", "The cards", "Where each field comes
 * from"). The mapping is pure, so its rules are swept here once; the
 * component tests prove the deck renders and acts on what it returns.
 */

const cardOf = (cards: ReturnType<typeof needsYouCards>, key: string) => {
  const card = cards.find((each) => each.key === key);
  if (card === undefined) {
    throw new Error(`no card ${key}`);
  }
  return card;
};

describe('one order, bundled', () => {
  it('follows the queue across projects and puts each bundle at its first decision’s place', () => {
    const cards = needsYouCards(
      report([
        stopped('FLT-d2'),
        decision('FLT-q1', { delivery: 'FLT-d2' }),
        decision('MMR-q5', {}),
        blocked('MMR-7'),
        decision('FLT-q2', { delivery: 'FLT-d2' }),
        question('FLT-8'),
        decision('MMR-q6', {}),
      ]),
    );
    expect(cards.map((card) => card.key)).toEqual([
      'FLT-d2',
      'delivery:FLT-d2',
      'project:MMR',
      'MMR-7',
      'FLT-8',
    ]);
    expect(cardOf(cards, 'delivery:FLT-d2').action).toMatchObject({ label: 'Review 2 decisions' });
    expect(cardOf(cards, 'project:MMR').action).toMatchObject({ label: 'Review 2 decisions' });
  });

  it('skips a queue member whose row is not in the report', () => {
    const rows = report([question('MMR-8')]);
    const cards = needsYouCards({
      ...rows,
      queue: [{ id: 'MMR-99', kind: 'task' }, ...rows.queue],
    });
    expect(cards.map((card) => card.key)).toEqual(['MMR-8']);
  });

  it('gives a stopped delivery and its own bundle two identities', () => {
    const cards = needsYouCards(
      report([stopped('FLT-d2'), decision('FLT-q1', { delivery: 'FLT-d2' })]),
    );
    expect(cards.map((card) => card.key)).toEqual(['FLT-d2', 'delivery:FLT-d2']);
  });
});

describe('a delivery’s bundle', () => {
  const facts: ReviewReport['needsYouFacts'] = {
    bundles: [{ set: { id: 'FLT-d2', kind: 'delivery' }, tasks: ['FLT-88', 'FLT-89'] }],
    deliveries: [
      {
        id: 'FLT-d2',
        phase: { id: 'FLT-2', title: 'Fleet 2.1: host upgrades' },
        title: 'Rolling host upgrades',
      },
    ],
  };

  it('leads with Decisions, its ID and project, and reads its title, tasks, and phase from the facts', () => {
    const [card] = needsYouCards(
      report(
        [
          decision('FLT-q1', { at: hoursAgo(1), delivery: 'FLT-d2', tasks: ['FLT-88'] }),
          decision('FLT-q3', { at: T0, delivery: 'FLT-d2', tasks: ['FLT-89'] }),
          decision('FLT-q4', { delivery: 'FLT-d2' }),
        ],
        { facts },
      ),
    );
    expect(card).toMatchObject({
      action: {
        kind: 'review',
        label: 'Review 3 decisions',
        name: 'Review 3 decisions on FLT-d2',
        set: { id: 'FLT-d2', kind: 'delivery' },
      },
      at: hoursAgo(1),
      detail: 'Across 2 tasks.',
      id: 'FLT-d2',
      lead: { kind: 'attention', word: 'Decisions' },
      project: 'Fleet',
      title: 'Rolling host upgrades',
    });
    expect(card?.preview).toEqual({
      facts: [
        { ids: ['FLT-88', 'FLT-89'], label: 'Tasks' },
        { label: 'Phase', text: 'Fleet 2.1: host upgrades' },
      ],
      open: { id: 'FLT-d2', kind: 'delivery' },
      reason: { text: 'This delivery has 3 provisional decisions.' },
    });
  });

  it('names its phase by ID when the phase has no title', () => {
    const [card] = needsYouCards(
      report([decision('FLT-q1', { delivery: 'FLT-d2' })], {
        facts: {
          bundles: [],
          deliveries: [
            { id: 'FLT-d2', phase: { id: 'FLT-2', title: null }, title: 'Rolling host upgrades' },
          ],
        },
      }),
    );
    expect(card?.preview.facts).toEqual([{ label: 'Phase', text: 'FLT-2' }]);
  });

  it('falls back to “Decisions on” its ID with no Phase, and to no work built, when the facts lack it', () => {
    const [card] = needsYouCards(report([decision('FLT-q1', { delivery: 'FLT-d2' })]));
    expect(card).toMatchObject({
      action: { label: 'Review 1 decision', name: 'Review 1 decision on FLT-d2' },
      detail: 'No work is built on it yet.',
      title: 'Decisions on FLT-d2',
    });
    expect(card?.preview.facts).toEqual([]);
    expect(card?.preview.reason).toEqual({ text: 'This delivery has 1 provisional decision.' });
  });

  it('counts one task in the singular', () => {
    const [card] = needsYouCards(
      report(
        [decision('FLT-q1', { delivery: 'FLT-d2' }), decision('FLT-q2', { delivery: 'FLT-d2' })],
        {
          facts: {
            bundles: [{ set: { id: 'FLT-d2', kind: 'delivery' }, tasks: ['FLT-88'] }],
            deliveries: [],
          },
        },
      ),
    );
    expect(card?.detail).toBe('Across 1 task.');
  });
});

describe('a project’s bundle', () => {
  it('leads with the project’s key and name and reads as decisions without a delivery', () => {
    const [card] = needsYouCards(
      report([decision('MMR-q5', { tasks: ['MMR-40'] }), decision('MMR-q6', {})], {
        facts: {
          bundles: [{ set: { key: 'MMR', kind: 'project' }, tasks: ['MMR-40'] }],
          deliveries: [],
        },
      }),
    );
    expect(card).toMatchObject({
      action: {
        kind: 'review',
        label: 'Review 2 decisions',
        name: 'Review 2 decisions without a delivery in MMR',
        set: { key: 'MMR', kind: 'project' },
      },
      detail: 'Across 1 task.',
      id: 'MMR',
      key: 'project:MMR',
      project: 'Mimir',
      title: 'Mimir decisions without a delivery',
    });
    expect(card?.preview).toEqual({
      facts: [{ ids: ['MMR-40'], label: 'Tasks' }],
      open: { key: 'MMR', kind: 'project' },
      reason: { text: 'This project has 2 provisional decisions without a delivery.' },
    });
  });

  it('shows its key alone when the project is missing from the report’s projects, and no Tasks fact without tasks', () => {
    const [card] = needsYouCards(report([decision('NORN-q1', {})], { names: {} }));
    expect(card).toMatchObject({
      detail: 'No work is built on it yet.',
      id: 'NORN',
      title: 'NORN decisions without a delivery',
    });
    expect(card?.project).toBeUndefined();
    expect(card?.preview.facts).toEqual([]);
  });
});

describe('a stopped delivery', () => {
  it('leads with Stopped, shows its reason, and splits the reason’s first sentence from the rest in its preview', () => {
    const cards = needsYouCards(
      report(
        [
          stopped('FLT-d2', {
            at: hoursAgo(4),
            reason: 'Stopped by its time cap. FLT-88’s drain hung. It waits on a lease.',
          }),
          decision('FLT-q1', { delivery: 'FLT-d2' }),
          decision('FLT-q2', { delivery: 'FLT-d2' }),
        ],
        {
          facts: {
            bundles: [],
            deliveries: [
              {
                id: 'FLT-d2',
                phase: { id: 'FLT-2', title: 'Fleet 2.1: host upgrades' },
                title: 'Rolling host upgrades',
              },
            ],
          },
        },
      ),
    );
    const card = cardOf(cards, 'FLT-d2');
    expect(card).toMatchObject({
      action: {
        delivery: 'FLT-d2',
        kind: 'clear-stop',
        label: 'Clear stop',
        name: 'Clear stop on FLT-d2',
      },
      at: hoursAgo(4),
      detail: 'Stopped by its time cap. FLT-88’s drain hung. It waits on a lease.',
      id: 'FLT-d2',
      lead: { kind: 'attention', word: 'Stopped' },
      project: 'Fleet',
      title: 'Delivery FLT-d2',
    });
    expect(card.preview).toEqual({
      facts: [
        {
          label: 'Decisions',
          text: '2 decisions on this delivery are waiting. They are their own card in Needs you.',
        },
        { label: 'Phase', text: 'Fleet 2.1: host upgrades' },
      ],
      open: { id: 'FLT-d2', kind: 'delivery' },
      reason: { text: 'Stopped by its time cap.' },
      text: 'FLT-88’s drain hung. It waits on a lease.',
    });
  });

  it('shows no detail without a reason, says it is stopped, and names its phase by ID without facts', () => {
    const [card] = needsYouCards(report([stopped('MMR-d9')]));
    expect(card?.detail).toBeUndefined();
    expect(card?.preview).toEqual({
      facts: [{ label: 'Phase', text: 'MMR-2' }],
      open: { id: 'MMR-d9', kind: 'delivery' },
      reason: { text: 'This delivery is stopped.' },
    });
  });

  it('keeps a one-sentence reason whole', () => {
    const [card] = needsYouCards(
      report([stopped('MMR-d9', { reason: 'The agent stopped itself' })]),
    );
    expect(card?.preview.reason).toEqual({ text: 'The agent stopped itself' });
    expect(card?.preview.text).toBeUndefined();
  });
});

describe('a task', () => {
  it('that needs answers leads with Question, shows its question, and Answer…', () => {
    const [card] = needsYouCards(report([question('FLT-8')]));
    expect(card).toMatchObject({
      action: {
        kind: 'answer',
        label: 'Answer…',
        name: 'Answer FLT-8',
        question: 'Where does the pin live?',
        task: 'FLT-8',
      },
      at: hoursAgo(2),
      detail: 'Where does the pin live?',
      id: 'FLT-8',
      lead: { kind: 'attention', word: 'Question' },
      project: 'Fleet',
      title: 'Task FLT-8',
    });
    expect(card?.preview).toMatchObject({
      open: { id: 'FLT-8', kind: 'task' },
      reason: { strong: 'Needs an answer before it can start.', text: 'Where does the pin live?' },
    });
  });

  it('that is blocked on you shows its reason and has no button', () => {
    const [card] = needsYouCards(report([blocked('MMR-7')]));
    expect(card).toMatchObject({
      detail: 'Approve the account.',
      lead: { kind: 'status', status: 'blocked' },
    });
    expect(card?.action).toBeUndefined();
    expect(card?.preview.reason).toEqual({
      strong: 'Blocked on you.',
      text: 'Approve the account.',
    });
  });

  it('leaves the detail out when its question or block reason is missing', () => {
    const cards = needsYouCards(report([question('MMR-8', null), blocked('MMR-7', null)]));
    expect(cards.map((card) => card.detail)).toEqual([undefined, undefined]);
    expect(cards.map((card) => card.preview.reason)).toEqual([
      { strong: 'Needs an answer before it can start.' },
      { strong: 'Blocked on you.' },
    ]);
  });

  it('carries its parent, size, and priority as facts when it has them', () => {
    const row = needsYouRow(
      { id: 'MMR-8', parent: 'MMR-3', priority: 'p1', size: 'small', status: 'ready' },
      'needs_answers',
    );
    const [card] = needsYouCards(report([row]));
    expect(card?.preview.facts).toEqual([
      { ids: ['MMR-3'], label: 'Parent' },
      { label: 'Size', text: 'Small' },
      { label: 'Priority', text: 'p1' },
    ]);
  });
});
