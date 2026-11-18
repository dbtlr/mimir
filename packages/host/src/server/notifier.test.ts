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

const titleOf = async (id: string) => `Title of ${id}`;

const flush = async () => {
  for (let turn = 0; turn < 40; turn += 1) {
    await Promise.resolve();
  }
};

/** A notifier on a fake clock, a scripted review read, and recording channels. */
function rig(initial: FixtureMember[] | Error = [], extraChannels: NotificationChannel[] = []) {
  let current: ReviewRead | Error = initial instanceof Error ? initial : reviewOf(initial);
  let time = 10_000;
  /** The wall clock is the monotonic one plus this; a test steps it alone. */
  let wallOffset = 1_700_000_000_000;
  let titleRead = titleOf;
  const timers: { at: number; handle: number; run: () => void }[] = [];
  let nextHandle = 1;
  const state = {
    asOfs: [] as number[],
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
    monotonicNow: () => time,
    reads: {
      deliveryTitle: (id) => titleRead(id),
      review: async ({ asOf }) => {
        state.reads += 1;
        state.asOfs.push(asOf.getTime());
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
    wallNow: () => time + wallOffset,
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
    /** The log lines as objects, each with a valid ISO `time` taken out. */
    lines: () =>
      logs.map((line) => {
        const { time: at, ...rest } = JSON.parse(line) as {
          [field: string]: unknown;
          time: string;
        };
        expect(new Date(at).toISOString()).toBe(at);
        return rest;
      }),
    logs,
    notifier,
    set: (next: FixtureMember[] | Error) => {
      current = next instanceof Error ? next : reviewOf(next);
    },
    setTitleRead: (read: (id: string) => Promise<string>) => {
      titleRead = read;
    },
    /** Move the monotonic clock without firing any timer, as a stalled event loop does. */
    stall: (ms: number) => {
      time += ms;
    },
    state,
    /** Step the wall clock alone; the monotonic clock does not move. */
    stepWall: (ms: number) => {
      wallOffset += ms;
    },
    timers,
    wallTime: () => time + wallOffset,
    /** A write that succeeded. */
    write: (actor: 'operator' | 'other') => {
      notifier.marks.began(actor);
      notifier.marks.succeeded(actor);
    },
  };
}

const task1 = blockedTask('MMR-1', 'Wire it', 'Need a key');

/** Two deliveries with decisions; the first title read is held. */
async function twoDeliveries() {
  const r = rig([]);
  await r.notifier.boot();
  const started: string[] = [];
  const first = Promise.withResolvers<string>();
  r.setTitleRead((id) => {
    started.push(id);
    return id === 'MMR-d3' ? first.promise : Promise.resolve(`Title of ${id}`);
  });
  r.set([decision('MMR-q1', 'MMR-d3'), decision('MMR-q2', 'MMR-d4')]);
  r.write('other');
  await r.advance(WINDOW_QUIET_MS);
  expect(started).toEqual(['MMR-d3']);
  return { first, r, started };
}

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
    expect(r.lines()).toEqual([{ event: 'needs_you_withheld', ids: 'MMR-1' }]);
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
    expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
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
    expect(r.lines().filter((line) => line.event === 'needs_you_channel_fault')).toHaveLength(2);
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
    const remaining = 10_000 - 6 * 1_500; // the contract's 10 seconds, spelled out
    await r.advance(remaining - 1);
    expect(r.state.reads).toBe(1);
    await r.advance(1);
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
    expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
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
    expect(r.lines().map((line) => line.event)).toEqual(['needs_you_event']);
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
    expect(r.timers).toEqual([]);
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

  test('it leaves no timer armed while a check is running', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.holdNextRead();
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.timers).toHaveLength(1); // the running check's read limit
    r.notifier.close();
    expect(r.timers).toEqual([]);
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
    expect(r.lines()).toEqual([
      {
        count: 1,
        event: 'needs_you_event',
        ids: 'MMR-d3',
        kind: 'delivery_stopped',
        target: '/p/MMR/d3',
      },
    ]);
    // `time` is the wall clock's instant, as ISO text.
    expect(JSON.parse(r.logs[0]!).time).toBe(new Date(r.wallTime()).toISOString());
    expect(r.logs.join('')).not.toContain('Secret');
  });
});

describe('a check commits only when it succeeds', () => {
  test('a delivery-title read that throws fails the check and leaves its entries for the next', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.setTitleRead(() => {
      throw new Error('synchronous fault');
    });
    r.set([decision('MMR-q1', 'MMR-d3')]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
    expect(r.events).toEqual([]);
    r.setTitleRead(titleOf);
    // The failed check kept its cause, so even an operator write reports the entry.
    r.write('operator');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-q1']]);
  });
});

describe('the clocks', () => {
  test('a wall clock that steps changes neither a window length nor the review read time', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('other');
    await r.advance(1_500);
    r.stepWall(-3_600_000);
    await r.advance(WINDOW_QUIET_MS - 1_500 - 1);
    expect(r.state.reads).toBe(1);
    await r.advance(1);
    expect(r.state.reads).toBe(2);
    expect(r.state.asOfs.at(-1)).toBe(r.wallTime());
    r.write('other');
    r.stepWall(7_200_000);
    await r.advance(WINDOW_QUIET_MS);
    expect(r.state.reads).toBe(3);
    expect(r.state.asOfs.at(-1)).toBe(r.wallTime());
  });

  test('a wall clock stepped forward between two signals does not shorten the window', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('other');
    r.stepWall(3_600_000);
    await r.advance(500);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS - 1);
    expect(r.state.reads).toBe(1);
    await r.advance(1);
    expect(r.state.reads).toBe(2);
  });

  test('a wall clock stepped back does not make a retired mutation a cause again', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.stepWall(-3_600_000);
    r.set([task1]);
    r.write('operator');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events).toEqual([]);
    expect(r.lines()).toEqual([{ event: 'needs_you_withheld', ids: 'MMR-1' }]);
  });
});

describe('the limit on reads', () => {
  test('a review read that never settles fails the check at 30 seconds and its late result is ignored', async () => {
    const r = rig([]);
    await r.notifier.boot();
    const held = r.holdNextRead();
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    await r.advance(30_000 - 1);
    expect(r.lines()).toEqual([]);
    await r.advance(1);
    expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
    r.set([task1]);
    held.release();
    await flush();
    expect(r.events).toEqual([]);
    expect(r.lines()).toHaveLength(1);
    // Later windows run, and the late read replaced nothing: the entry is still news.
    r.write('operator');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.state.reads).toBe(3);
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-1']]);
  });

  test('a delivery-title read that never settles fails the check at 30 seconds', async () => {
    const r = rig([]);
    await r.notifier.boot();
    const never = Promise.withResolvers<string>();
    r.setTitleRead(() => never.promise);
    r.set([decision('MMR-q1', 'MMR-d3')]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS + 30_000 - 1);
    expect(r.lines()).toEqual([]);
    await r.advance(1);
    expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
    never.resolve('Late title');
    await flush();
    expect(r.events).toEqual([]);
    r.setTitleRead(titleOf);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => event.title)).toEqual(['Decision on Title of MMR-d3']);
  });

  test('a boot read that never settles resolves boot at 30 seconds with a fault', async () => {
    const r = rig([task1]);
    const held = r.holdNextRead();
    let resolved = false;
    const booting = (async () => {
      await r.notifier.boot();
      resolved = true;
    })();
    await r.advance(30_000 - 1);
    expect(resolved).toBe(false);
    await r.advance(1);
    await booting;
    expect(resolved).toBe(true);
    expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
    held.release();
    await flush();
    expect(r.lines()).toHaveLength(1);
    expect(r.timers).toEqual([]);
  });

  test('a review read that settles past 30 seconds before its timer runs is a fault and commits nothing', async () => {
    const r = rig([]);
    await r.notifier.boot();
    const held = r.holdNextRead();
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.set([task1]);
    r.stall(30_000);
    held.release();
    await flush();
    expect(r.events).toEqual([]);
    expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
    // Nothing was remembered or retired: the next check still reports the entry.
    await r.advance(30_000);
    r.write('operator');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-1']]);
  });

  test('a title read that settles past 30 seconds before its timer runs is a fault and commits nothing', async () => {
    const r = rig([]);
    await r.notifier.boot();
    const slow = Promise.withResolvers<string>();
    r.setTitleRead(() => slow.promise);
    r.set([decision('MMR-q1', 'MMR-d3')]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.stall(30_000);
    slow.resolve('Late title');
    await flush();
    expect(r.events).toEqual([]);
    expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
    r.setTitleRead(titleOf);
    await r.advance(30_000);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => event.title)).toEqual(['Decision on Title of MMR-d3']);
  });

  test('a read that settles at 29,999 ms still succeeds', async () => {
    const r = rig([]);
    await r.notifier.boot();
    const held = r.holdNextRead();
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.set([task1]);
    r.stall(30_000 - 1);
    held.release();
    await flush();
    expect(r.lines().map((line) => line.event)).toEqual(['needs_you_event']);
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-1']]);
  });

  test('a boot read that settles past 30 seconds before its timer runs is a fault and remembers nothing', async () => {
    const r = rig([task1]);
    const held = r.holdNextRead();
    const booting = r.notifier.boot();
    r.stall(30_000);
    held.release();
    await booting;
    expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
    // Nothing was remembered, so the next read is the first: it emits nothing
    // even for a member the boot read did not see.
    r.set([task1, blockedTask('MMR-2')]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events).toEqual([]);
    expect(r.lines()).toHaveLength(1);
    // That read was remembered, so the check after it reports only what is new.
    r.set([task1, blockedTask('MMR-2'), blockedTask('MMR-3')]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-3']]);
  });

  test('a review read that settles past 30 seconds before its timer runs reads no delivery title', async () => {
    const r = rig([]);
    await r.notifier.boot();
    let titleReads = 0;
    r.setTitleRead(async (id) => {
      titleReads += 1;
      return titleOf(id);
    });
    const held = r.holdNextRead();
    r.set([decision('MMR-q1', 'MMR-d3')]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.stall(30_000);
    held.release();
    await flush();
    expect(titleReads).toBe(0);
    expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
  });

  test('a check that finishes in time leaves no limit timer armed', async () => {
    const r = rig([]);
    await r.notifier.boot();
    expect(r.timers).toEqual([]);
  });
});

describe('boot runs once', () => {
  test('a second call does nothing, while the first runs and after it', async () => {
    const r = rig([task1]);
    const held = r.holdNextRead();
    const first = r.notifier.boot();
    await r.notifier.boot();
    expect(r.state.reads).toBe(1);
    held.release();
    await first;
    await r.notifier.boot();
    expect(r.state.reads).toBe(1);
    expect(r.state.maxInRead).toBe(1);
  });

  test('a boot after close does nothing', async () => {
    const r = rig([task1]);
    r.notifier.close();
    await r.notifier.boot();
    expect(r.state.reads).toBe(0);
  });
});

describe('the cases a mutation could slip through', () => {
  test('a mutation that succeeds mid-read stays a cause of the next check', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('operator');
    const held = r.holdNextRead();
    await r.advance(WINDOW_QUIET_MS);
    await r.advance(500);
    r.write('other');
    await r.advance(500);
    held.release();
    await flush();
    r.set([task1]);
    r.write('operator');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events.map((event) => event.ids)).toEqual([['MMR-1']]);
  });

  test('a failed mutation stops counting as in flight', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.notifier.marks.began('other');
    r.notifier.marks.failed('other');
    r.set([task1]);
    r.write('operator');
    await r.advance(WINDOW_QUIET_MS);
    expect(r.events).toEqual([]);
    expect(r.lines()).toEqual([{ event: 'needs_you_withheld', ids: 'MMR-1' }]);
  });

  test('close during a read whose entries would be withheld logs nothing', async () => {
    const r = rig([]);
    await r.notifier.boot();
    r.write('operator');
    const held = r.holdNextRead();
    await r.advance(WINDOW_QUIET_MS);
    r.set([task1]);
    r.notifier.close();
    held.release();
    await flush();
    expect(r.logs).toEqual([]);
  });

  test('close during the read builds no event and reads no title', async () => {
    const r = rig([]);
    await r.notifier.boot();
    let titleReads = 0;
    r.setTitleRead(async () => {
      titleReads += 1;
      return 'Title';
    });
    r.write('other');
    const held = r.holdNextRead();
    await r.advance(WINDOW_QUIET_MS);
    r.set([decision('MMR-q1', 'MMR-d3')]);
    r.notifier.close();
    held.release();
    await flush();
    expect(titleReads).toBe(0);
    expect(r.events).toEqual([]);
  });

  test('close during the build emits nothing and logs nothing', async () => {
    const r = rig([]);
    await r.notifier.boot();
    const title = Promise.withResolvers<string>();
    r.setTitleRead(() => title.promise);
    r.set([decision('MMR-q1', 'MMR-d3')]);
    r.write('other');
    await r.advance(WINDOW_QUIET_MS);
    r.notifier.close();
    title.resolve('Late');
    await flush();
    expect(r.events).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  describe('the title reads of one build', () => {
    test('a read that settles past 30 seconds starts no further title read, and commits nothing', async () => {
      const { first, r, started } = await twoDeliveries();
      r.stall(30_000);
      first.resolve('Late');
      await flush();
      expect(started).toEqual(['MMR-d3']);
      expect(r.events).toEqual([]);
      expect(r.lines()).toEqual([{ event: 'needs_you_check_fault' }]);
      r.write('other');
      await r.advance(WINDOW_QUIET_MS);
      expect(r.events.map((event) => event.ids)).toEqual([['MMR-q1'], ['MMR-q2']]);
    });

    test('a close while a read is pending starts no further title read and logs nothing', async () => {
      const { first, r, started } = await twoDeliveries();
      r.notifier.close();
      first.resolve('Late');
      await flush();
      expect(started).toEqual(['MMR-d3']);
      expect(r.events).toEqual([]);
      expect(r.logs).toEqual([]);
    });

    test('reads that finish in time build every event', async () => {
      const { first, r, started } = await twoDeliveries();
      first.resolve('First');
      await flush();
      expect(started).toEqual(['MMR-d3', 'MMR-d4']);
      expect(r.events.map((event) => event.ids)).toEqual([['MMR-q1'], ['MMR-q2']]);
    });
  });
});
