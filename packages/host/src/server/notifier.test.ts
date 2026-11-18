import { describe, expect, test } from 'bun:test';

import type { NotificationEvent, ReviewRead } from './notification-events';
import {
  askingTask,
  blockedTask,
  decision,
  reviewOf,
  stoppedDelivery,
} from './notification-fixtures';
import type { FixtureMember } from './notification-fixtures';
import { createNotifier, WINDOW_MAX_MS, WINDOW_QUIET_MS } from './notifier';
import type { NotificationChannel } from './notifier';

type Gate = { release: () => void; wait: Promise<void> };
function gate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { release: resolve, wait: promise };
}

const flush = async () => {
  for (let turn = 0; turn < 40; turn += 1) {
    await Promise.resolve();
  }
};

/** A notifier on a fake clock, a scripted review read, and recording channels. */
function rig(initial: FixtureMember[] | Error = [], extraChannels: NotificationChannel[] = []) {
  let current: ReviewRead | Error = initial instanceof Error ? initial : reviewOf(initial);
  let time = 10_000;
  const timers: { at: number; handle: number; run: () => void }[] = [];
  let nextHandle = 1;
  const state = {
    gates: [] as Gate[],
    inRead: 0,
    maxInRead: 0,
    readStarts: [] as number[],
    reads: 0,
  };
  const logs: string[] = [];
  const events: NotificationEvent[] = [];
  const notifier = createNotifier({
    channels: [{ deliver: async (event) => void events.push(event) }, ...extraChannels],
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index !== -1) {
        timers.splice(index, 1);
      }
    },
    log: (line) => void logs.push(line),
    now: () => time,
    reads: {
      deliveryTitle: async (id) => `Title of ${id}`,
      review: async () => {
        state.reads += 1;
        state.readStarts.push(time);
        state.inRead += 1;
        state.maxInRead = Math.max(state.maxInRead, state.inRead);
        try {
          const pending = state.gates.shift();
          if (pending !== undefined) {
            await pending.wait;
          }
          if (current instanceof Error) {
            throw current;
          }
          return current;
        } finally {
          state.inRead -= 1;
        }
      },
    },
    setTimer: (run, ms) => {
      const handle = nextHandle++;
      timers.push({ at: time + ms, handle, run });
      return handle;
    },
  });
  return {
    /** Move the clock forward, firing each timer at its own instant. */
    advance: async (ms: number) => {
      const target = time + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (next === undefined || next.at > target) {
          break;
        }
        timers.shift();
        time = next.at;
        next.run();
        await flush();
      }
      time = target;
      await flush();
    },
    events,
    /** Make the next read wait until the returned gate is released. */
    holdNextRead: () => {
      const held = gate();
      state.gates.push(held);
      return held;
    },
    logs,
    notifier,
    set: (next: FixtureMember[] | Error) => {
      current = next instanceof Error ? next : reviewOf(next);
    },
    state,
    timers,
    /** A write that succeeded. */
    write: (actor: 'operator' | 'other') => {
      notifier.marks.began(actor);
      notifier.marks.succeeded(actor);
    },
  };
}

const task1 = blockedTask('MMR-1', 'Wire it', 'Need a key');

describe('what counts as an entry', () => {
  test('a member that leaves the set and returns is an entry again, and one that stays is not', async () => {
    const r = rig([task1]);
    await r.notifier.boot();
    r.set([]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events).toEqual([]);
    r.set([task1]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-1']]);
  });

  test('a task that needs answers and becomes blocked keeps its identity and is no entry', async () => {
    const r = rig([askingTask('MMR-1')]);
    await r.notifier.boot();
    r.set([blockedTask('MMR-1')]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events).toEqual([]);
  });

  test('one check emits one grouped event for decisions on a delivery, in queue order', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.set([
      blockedTask('MMR-1'),
      decision('MMR-q1', 'MMR-d3'),
      stoppedDelivery('MMR-d4', 4),
      decision('MMR-q2', 'MMR-d3'),
    ]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => [event.kind, event.ids])).toEqual([
      ['task_blocked', ['MMR-1']],
      ['decisions', ['MMR-q1', 'MMR-q2']],
      ['delivery_stopped', ['MMR-d4']],
    ]);
  });
});

describe('who is told', () => {
  test('an entry caused only by the operator is withheld, logged, and never reported later', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.set([task1]);
    r.write('operator');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events).toEqual([]);
    expect(r.logs).toContain('needs_you_withheld ids=MMR-1');
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events).toEqual([]);
  });

  test('one other cause reports the entries of a check the operator also wrote in', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.set([task1]);
    r.write('operator');
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events).toHaveLength(1);
  });
});

describe('boot', () => {
  test('boot emits nothing and logs nothing', async () => {
    const r = rig([task1]);
    await r.notifier.boot();
    expect(r.events).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  test('a failed boot read is logged, resolves, and the next successful read emits nothing', async () => {
    const r = rig(new Error('store down'));
    await r.notifier.boot();
    expect(r.logs).toEqual(['needs_you_check_fault']);
    r.set([task1]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events).toEqual([]);
    r.set([task1, blockedTask('MMR-2')]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-2']]);
  });
});

describe('channels', () => {
  test('a rejecting and a throwing channel are logged and the others still get the event', async () => {
    const seen: NotificationEvent[] = [];
    const r = rig(
      [],
      [
        { deliver: () => Promise.reject(new Error('push down with secret title')) },
        {
          deliver: () => {
            throw new Error('broken');
          },
        },
        { deliver: async (event) => void seen.push(event) },
      ],
    );
    await r.notifier.boot();
    r.set([task1]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    await flush();
    expect(seen).toHaveLength(1);
    expect(r.events).toHaveLength(1);
    expect(r.logs.filter((line) => line.startsWith('needs_you_channel_fault'))).toHaveLength(2);
  });
});

describe('the window', () => {
  test('it closes 2 seconds after the latest signal', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('other');
    await r.advance(1_500);
    r.write('other');
    await r.advance(1_999);
    expect(r.state.reads).toBe(1);
    await r.advance(1);
    expect(r.state.reads).toBe(2);
  });

  test('it closes at most 10 seconds after it opened', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('other');
    for (let step = 0; step < 6; step += 1) {
      await r.advance(1_500);
      r.write('other');
    }
    expect(r.state.reads).toBe(1);
    await r.advance(WINDOW_MAX_MS - 6 * 1_500);
    expect(r.state.reads).toBe(2);
  });

  test('a window that closes during a running check makes one waiting check, and checks never overlap', async () => {
    const r = rig([]);
    await r.notifier.boot();
    const held = r.holdNextRead();
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.state.reads).toBe(2);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.state.reads).toBe(2);
    held.release();
    await flush();
    await r.advance(WINDOW_QUIET_MS * 3);
    expect(r.state.reads).toBe(3);
    expect(r.state.maxInRead).toBe(1);
  });

  test('a failed mutation signals nothing', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.notifier.marks.began('other');
    r.notifier.marks.failed('other');
    await r.advance(WINDOW_MAX_MS * 2);
    expect(r.state.reads).toBe(1);
    expect(r.timers).toEqual([]);
  });
});

describe('causes and retirement', () => {
  test('a mutation in flight when the read returns is a cause', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('operator');
    const held = r.holdNextRead();
    await r.advance(WINDOW_QUIET_MS);
    r.notifier.marks.began('other');
    r.set([task1]);
    held.release();
    await flush();
    expect(r.events).toHaveLength(1);
  });

  test('a mutation that succeeds during the read is a cause of that check and of the next', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('operator');
    const held = r.holdNextRead();
    await r.advance(WINDOW_QUIET_MS);
    r.write('other');
    r.set([task1]);
    held.release();
    await flush();
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-1']]);
    r.set([task1, blockedTask('MMR-2')]);
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-1'], ['MMR-2']]);
  });

  test('a mutation that succeeded before a check read is retired by it', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.set([task1]);
    r.write('operator');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events).toEqual([]);
  });

  test('a failed check retires nothing and replaces nothing', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('other');
    r.set(new Error('store down'));
    await r.advance(WINDOW_QUIET_MS);
    expect(r.logs).toEqual(['needs_you_check_fault']);
    r.set([task1]);
    r.write('operator');
    await r.advance(WINDOW_QUIET_MS);
    // The earlier other write is still a cause, so the operator's entry is reported.
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-1']]);
  });

  test('a check with no causes reports its entries', async () => {
    const r = rig([]);
    r.write('operator'); // before the boot read, which retires it
    await r.advance(1);
    await r.notifier.boot();
    r.set([task1]);
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-1']]);
    expect(r.logs.filter((line) => line.startsWith('needs_you_withheld'))).toEqual([]);
  });
});

describe('close', () => {
  test('it cancels an open window and ignores later marks', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('other');
    r.notifier.close();
    expect(r.timers).toEqual([]);
    r.write('other');
    await r.advance(WINDOW_MAX_MS * 2);
    expect(r.state.reads).toBe(1);
  });

  test('it cancels a waiting check', async () => {
    const r = rig([]);
    await r.notifier.boot();
    const held = r.holdNextRead();
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.notifier.close();
    held.release();
    await flush();
    expect(r.state.reads).toBe(2);
  });

  test('it discards a running check result without a log', async () => {
    const r = rig([]);
    await r.notifier.boot();
    const held = r.holdNextRead();
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.set([task1]);
    r.notifier.close();
    held.release();
    await flush();
    expect(r.events).toEqual([]);
    expect(r.logs).toEqual([]);
    const failing = rig([]);
    await failing.notifier.boot();
    const failingGate = failing.holdNextRead();
    failing.write('other');
    await failing.advance(WINDOW_QUIET_MS);
    failing.set(new Error('down'));
    failing.notifier.close();
    failingGate.release();
    await flush();
    expect(failing.logs).toEqual([]);
  });
});

describe('the log', () => {
  test('an event line carries kind, ids, target, and count, and never the title or body', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.set([stoppedDelivery('MMR-d3', 3, 'Secret title words', 'Secret body words')]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.logs).toEqual([
      'needs_you_event kind=delivery_stopped ids=MMR-d3 target=/p/MMR/d3 count=1',
    ]);
  });
});
