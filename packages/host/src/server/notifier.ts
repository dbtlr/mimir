import { logEvent } from './log-event';
import { buildEvents, entryKey } from './notification-events';
import type { NotificationEvent, QueueEntry, ReviewRead } from './notification-events';

/*
 * The notifier (ADR 0045): compares the needs-you set across checks and
 * turns the entries into events. It knows no verb. A caller's view tells it
 * when a mutation began, succeeded, or failed; it reaches work state only
 * through two Engine reads and writes nothing.
 */

/** Who made a write. */
export type Actor = 'operator' | 'other';

/** The window closes this long after its latest signal, and at most {@link WINDOW_MAX_MS} after it opened. */
export const WINDOW_QUIET_MS = 2_000;
export const WINDOW_MAX_MS = 10_000;

/** A check's reads, and the boot read, have this long. */
export const READ_LIMIT_MS = 30_000;

/** The only recipient today. */
const RECIPIENT: Actor = 'operator';

/** A channel delivers events. It owns its own retries. */
export type NotificationChannel = {
  deliver: (event: NotificationEvent) => Promise<void>;
};

export type NotifierOptions<Handle> = {
  channels: readonly NotificationChannel[];
  clearTimer: (handle: Handle) => void;
  log: (line: string) => void;
  /** Times the window and the marks; it never steps backward. */
  monotonicNow: () => number;
  reads: {
    deliveryTitle: (id: string) => Promise<string>;
    review: (input: { asOf: Date; timeZone: 'UTC' }) => Promise<ReviewRead>;
  };
  setTimer: (run: () => void, ms: number) => Handle;
  /** The wall clock: the review read's instant and the log lines' time, nothing else. */
  wallNow: () => number;
};

/** What a view tells the notifier. Each call is synchronous, does no I/O, and never throws. */
export type MutationMarks = {
  began: (actor: Actor) => void;
  failed: (actor: Actor) => void;
  succeeded: (actor: Actor) => void;
};

export type Notifier = {
  /** Read the set once and remember it; emits nothing and never rejects. */
  boot: () => Promise<void>;
  /** Cancel the window and the waiting check, and ignore everything after. */
  close: () => void;
  marks: MutationMarks;
};

type ActorMark = { inFlight: number; lastSuccess: number | null };

export function createNotifier<Handle>(options: NotifierOptions<Handle>): Notifier {
  const { channels, clearTimer, log, monotonicNow, reads, setTimer, wallNow } = options;
  const marks = new Map<Actor, ActorMark>();
  let remembered: Set<string> | null = null;
  /** The monotonic instant the last successful check began its read; mutations that succeeded before it are retired. */
  let retiredBefore = Number.NEGATIVE_INFINITY;
  let closed = false;
  let booted = false;
  let windowOpenedAt: number | null = null;
  let windowTimer: Handle | null = null;
  const limitTimers = new Set<Handle>();
  let running = false;
  let waiting = false;

  const logEventLine = (event: string, fields: Record<string, number | string> = {}): void =>
    logEvent({ clock: wallNow, log }, event, fields);

  const markOf = (actor: Actor): ActorMark => {
    let mark = marks.get(actor);
    if (mark === undefined) {
      mark = { inFlight: 0, lastSuccess: null };
      marks.set(actor, mark);
    }
    return mark;
  };

  const causesNow = (): Set<Actor> => {
    const causes = new Set<Actor>();
    for (const [actor, mark] of marks) {
      if (mark.inFlight > 0 || (mark.lastSuccess !== null && mark.lastSuccess >= retiredBefore)) {
        causes.add(actor);
      }
    }
    return causes;
  };

  /** Hand an event to one channel; its fault is logged and goes no further. */
  async function deliver(channel: NotificationChannel, event: NotificationEvent): Promise<void> {
    try {
      await channel.deliver(event);
    } catch {
      logEventLine('needs_you_channel_fault', { ids: event.ids.join(','), kind: event.kind });
    }
  }

  const emit = (event: NotificationEvent): void => {
    logEventLine('needs_you_event', {
      count: event.needs_you,
      ids: event.ids.join(','),
      kind: event.kind,
      target: event.target,
    });
    for (const channel of channels) {
      void deliver(channel, event);
    }
  };

  /**
   * One check's work. It commits (replaces the remembered set, retires the
   * mutations) and emits only when its read and its events both succeeded and
   * `live` still holds: the host is open and the check is within its limit.
   * The limit is also judged against the monotonic clock at each decision, so
   * an overdue result fails the check even when its limit timer has not run.
   */
  async function attempt(live: () => boolean): Promise<void> {
    const startedAt = monotonicNow();
    const stillLive = (): boolean => {
      if (!live()) {
        return false;
      }
      if (monotonicNow() - startedAt >= READ_LIMIT_MS) {
        throw new Error('the check outran its read limit');
      }
      return true;
    };
    const review = await reads.review({ asOf: new Date(wallNow()), timeZone: 'UTC' });
    if (!stillLive()) {
      return;
    }
    const causes = causesNow();
    const previous = remembered;
    const entries: QueueEntry[] =
      previous === null ? [] : review.queue.filter((entry) => !previous.has(entryKey(entry)));
    const withheld =
      entries.length > 0 && causes.size > 0 && [...causes].every((cause) => cause === RECIPIENT);
    const events =
      entries.length > 0 && !withheld
        ? await buildEvents(entries, review, reads.deliveryTitle)
        : [];
    if (!stillLive()) {
      return;
    }
    remembered = new Set(review.queue.map(entryKey));
    retiredBefore = startedAt;
    if (withheld) {
      logEventLine('needs_you_withheld', { ids: entries.map((entry) => entry.id).join(',') });
    }
    for (const event of events) {
      emit(event);
    }
  }

  /** Run `attempt` under the read limit: past it the check fails and a late result is ignored. */
  async function limited(): Promise<void> {
    const outrun = Promise.withResolvers<never>();
    let expired = false;
    const handle = setTimer(() => {
      expired = true;
      limitTimers.delete(handle);
      outrun.reject(new Error('the check outran its read limit'));
    }, READ_LIMIT_MS);
    limitTimers.add(handle);
    try {
      await Promise.race([attempt(() => !closed && !expired), outrun.promise]);
    } finally {
      limitTimers.delete(handle);
      clearTimer(handle);
    }
  }

  /** Run one check; when a window closed meanwhile, run the one waiting check after it. */
  async function runCheck(): Promise<void> {
    running = true;
    try {
      await limited();
    } catch {
      if (!closed) {
        logEventLine('needs_you_check_fault');
      }
    }
    running = false;
    if (waiting && !closed) {
      waiting = false;
      void runCheck();
    }
  }

  function windowClosed(): void {
    windowOpenedAt = null;
    windowTimer = null;
    if (closed) {
      return;
    }
    if (running) {
      waiting = true;
    } else {
      void runCheck();
    }
  }

  function signal(): void {
    if (windowTimer !== null) {
      clearTimer(windowTimer);
    }
    const at = monotonicNow();
    windowOpenedAt ??= at;
    const delay = Math.min(WINDOW_QUIET_MS, windowOpenedAt + WINDOW_MAX_MS - at);
    windowTimer = setTimer(windowClosed, Math.max(0, delay));
  }

  /** Run a mark; a fault here must never reach the write. */
  const guarded =
    (apply: (actor: Actor) => void) =>
    (actor: Actor): void => {
      if (closed) {
        return;
      }
      try {
        apply(actor);
      } catch {
        // Marks are memory-only counters; nothing to report that could help.
      }
    };

  return {
    boot: async () => {
      if (booted || closed) {
        return;
      }
      booted = true;
      await runCheck();
    },
    close: () => {
      closed = true;
      waiting = false;
      if (windowTimer !== null) {
        clearTimer(windowTimer);
        windowTimer = null;
      }
      for (const handle of limitTimers) {
        clearTimer(handle);
      }
      limitTimers.clear();
      windowOpenedAt = null;
    },
    marks: {
      began: guarded((actor) => {
        markOf(actor).inFlight += 1;
      }),
      failed: guarded((actor) => {
        const mark = markOf(actor);
        mark.inFlight = Math.max(0, mark.inFlight - 1);
      }),
      succeeded: guarded((actor) => {
        const mark = markOf(actor);
        mark.inFlight = Math.max(0, mark.inFlight - 1);
        mark.lastSuccess = monotonicNow();
        signal();
      }),
    },
  };
}
