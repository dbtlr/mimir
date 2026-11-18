import { describe, expect, test } from 'bun:test';

import { BODY_LIMIT, TITLE_LIMIT, buildEvents, plainText } from './notification-events';
import type { QueueEntry } from './notification-events';
import {
  askingTask,
  blockedTask,
  decision,
  reviewOf,
  stoppedDelivery,
} from './notification-fixtures';

const live = () => true;
const titles = async (id: string) => `Title of ${id}`;

async function eventsOf(members: Parameters<typeof reviewOf>[0], read = titles) {
  const review = reviewOf(members);
  return buildEvents(review.queue, review, read, live);
}

describe('event building', () => {
  test('a stopped delivery is one delivery_stopped event', async () => {
    expect(await eventsOf([stoppedDelivery('MMR-d3', 3, 'Ship it', 'CI is red')])).toEqual([
      {
        body: 'CI is red',
        ids: ['MMR-d3'],
        kind: 'delivery_stopped',
        needs_you: 1,
        project: 'MMR',
        target: '/p/MMR/d3',
        title: 'Ship it',
      },
    ]);
  });

  test('decisions on one delivery are one grouped event that names the delivery', async () => {
    const events = await eventsOf([
      decision('MMR-q1', 'MMR-d3', 'Which store?'),
      decision('MMR-q2', 'MMR-d3', 'Which queue?'),
    ]);
    expect(events).toEqual([
      {
        body: 'Which store?',
        ids: ['MMR-q1', 'MMR-q2'],
        kind: 'decisions',
        needs_you: 2,
        project: 'MMR',
        target: '/p/MMR/d3?mode=decisions',
        title: '2 decisions on Title of MMR-d3',
      },
    ]);
  });

  test('a single decision on a delivery has no count, and a failed delivery read uses the id', async () => {
    const [event] = await eventsOf([decision('MMR-q1', 'MMR-d3')], async () => {
      throw new Error('gone');
    });
    expect(event?.title).toBe('Decision on MMR-d3');
    expect(event?.target).toBe('/p/MMR/d3?mode=decisions');
  });

  test('decisions with no delivery are one event per project, named by its key', async () => {
    const events = await eventsOf([decision('MMR-q1', null), decision('MMR-q2', null)]);
    expect(events).toEqual([
      {
        body: 'Which store?',
        ids: ['MMR-q1', 'MMR-q2'],
        kind: 'decisions',
        needs_you: 2,
        project: 'MMR',
        target: '/p/MMR?mode=decisions',
        title: '2 decisions on MMR',
      },
    ]);
  });

  test('a task blocked on the operator is one task_blocked event', async () => {
    expect(await eventsOf([blockedTask('MMR-708', 'Wire it', 'Need a key')])).toEqual([
      {
        body: 'Need a key',
        ids: ['MMR-708'],
        kind: 'task_blocked',
        needs_you: 1,
        project: 'MMR',
        target: '/p/MMR/708',
        title: 'Wire it',
      },
    ]);
  });

  test('a task that needs answers is one task_needs_answers event', async () => {
    expect(await eventsOf([askingTask('MMR-9', 'Groom it', 'Which API?')])).toEqual([
      {
        body: 'Which API?',
        ids: ['MMR-9'],
        kind: 'task_needs_answers',
        needs_you: 1,
        project: 'MMR',
        target: '/p/MMR/9',
        title: 'Groom it',
      },
    ]);
  });

  test('events follow queue order, and a decisions event takes its first member place', async () => {
    const events = await eventsOf([
      blockedTask('MMR-1'),
      decision('MMR-q1', 'MMR-d3'),
      stoppedDelivery('MMR-d4', 4),
      decision('MMR-q2', 'MMR-d3'),
    ]);
    expect(events.map((event) => event.ids)).toEqual([['MMR-1'], ['MMR-q1', 'MMR-q2'], ['MMR-d4']]);
  });

  test('only the given entries make events, but the count is the whole set', async () => {
    const review = reviewOf([blockedTask('MMR-1'), blockedTask('MMR-2')]);
    const entries: QueueEntry[] = [review.queue[1]!];
    const events = await buildEvents(entries, review, titles, live);
    expect(events.map((event) => [event.ids, event.needs_you])).toEqual([[['MMR-2'], 2]]);
  });

  test('a missing hold reason or question falls back to the id', async () => {
    const events = await eventsOf([
      stoppedDelivery('MMR-d3', 3, 'Ship it', null),
      blockedTask('MMR-1', 'Wire it', '   '),
      askingTask('MMR-2', 'Groom it', null),
    ]);
    expect(events.map((event) => event.body)).toEqual(['MMR-d3', 'MMR-1', 'MMR-2']);
  });
});

describe('event building, the cases a mutation could slip through', () => {
  test('decisions with no delivery group per project, never across projects', async () => {
    const events = await eventsOf([
      decision('AAA-q1', null, 'First?', 'AAA'),
      decision('BBB-q1', null, 'Second?', 'BBB'),
      decision('AAA-q2', null, 'Third?', 'AAA'),
    ]);
    expect(events.map((event) => [event.project, event.ids, event.target, event.title])).toEqual([
      ['AAA', ['AAA-q1', 'AAA-q2'], '/p/AAA?mode=decisions', '2 decisions on AAA'],
      ['BBB', ['BBB-q1'], '/p/BBB?mode=decisions', 'Decision on BBB'],
    ]);
  });

  test('a decision that names a delivery targets that delivery, never the project', async () => {
    const [event] = await eventsOf([decision('MMR-q1', 'MMR-d12')]);
    expect(event?.target).toBe('/p/MMR/d12?mode=decisions');
  });

  test('a blocked task with a hold reason and an open question carries the hold reason', async () => {
    const [event] = await eventsOf([blockedTask('MMR-1', 'Wire it', 'Need a key', 'Which API?')]);
    expect(event?.body).toBe('Need a key');
  });

  test('a task that needs answers carries its question, not a hold reason it also has', async () => {
    const [event] = await eventsOf([askingTask('MMR-1', 'Groom it', 'Which API?', 'Held')]);
    expect(event?.body).toBe('Which API?');
  });

  test('a task title is cut at 100 and a task body at 240', async () => {
    const [blocked] = await eventsOf([blockedTask('MMR-1', 't'.repeat(150), 'b'.repeat(300))]);
    expect(blocked?.title).toHaveLength(TITLE_LIMIT);
    expect(blocked?.body).toHaveLength(BODY_LIMIT);
    const [asking] = await eventsOf([askingTask('MMR-2', 't'.repeat(150), 'q'.repeat(300))]);
    expect(asking?.title).toHaveLength(TITLE_LIMIT);
    expect(asking?.body).toHaveLength(BODY_LIMIT);
  });

  test('a decisions title is cut at 100 and its body at 240', async () => {
    const [event] = await eventsOf([decision('MMR-q1', 'MMR-d3', 'q'.repeat(300))], async () =>
      'd'.repeat(300),
    );
    expect(event?.title).toHaveLength(TITLE_LIMIT);
    expect(event?.body).toHaveLength(BODY_LIMIT);
  });

  test('a queue entry with no row in the read is skipped, not thrown on', async () => {
    const review = reviewOf([blockedTask('MMR-1'), blockedTask('MMR-2')]);
    const entries: QueueEntry[] = [{ id: 'MMR-99', kind: 'task' }, review.queue[1]!];
    const events = await buildEvents(entries, review, titles, live);
    expect(events.map((event) => event.ids)).toEqual([['MMR-2']]);
  });
});

describe('plain text', () => {
  test('a space before the cut is trimmed so the ellipsis follows a word', () => {
    expect(plainText('aaaa bbbbbbbb', 6)).toBe('aaaa…');
  });

  test('runs of whitespace collapse to one space', () => {
    expect(plainText('  a \n\n b\t c  ', 100)).toBe('a b c');
  });

  test('a text over the limit is cut to end in an ellipsis inside it', () => {
    const cut = plainText('x'.repeat(300), 100);
    expect(cut).toHaveLength(100);
    expect(cut.endsWith('…')).toBe(true);
    expect(plainText('y'.repeat(100), 100)).toBe('y'.repeat(100));
  });

  test('a cut never leaves half of a surrogate pair', () => {
    const cut = plainText(`${'x'.repeat(98)}😀tail`, 100);
    expect(cut).toBe(`${'x'.repeat(98)}…`);
  });

  test('a title is cut at 100 characters and a body at 240', async () => {
    const [event] = await eventsOf([
      stoppedDelivery('MMR-d3', 3, 't'.repeat(200), 'b'.repeat(500)),
    ]);
    expect(event?.title).toHaveLength(100);
    expect(event?.body).toHaveLength(240);
  });
});
