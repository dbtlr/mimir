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
  now: () => number;
  reads: {
    deliveryTitle: (id: string) => Promise<string>;
    review: (input: { asOf: Date; timeZone: 'UTC' }) => Promise<ReviewRead>;
  };
  setTimer: (run: () => void, ms: number) => Handle;
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
  const { channels, clearTimer, log, now, reads, setTimer } = options;
  const marks = new Map<Actor, ActorMark>();
  let remembered: Set<string> | null = null;
  /** The instant the last successful check began its read; mutations that succeeded before it are retired. */
  let retiredBefore = Number.NEGATIVE_INFINITY;
  let closed = false;
  let windowOpenedAt: number | null = null;
  let windowTimer: Handle | null = null;
  let running = false;
  let waiting = false;

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
      log(`needs_you_channel_fault kind=${event.kind} ids=${event.ids.join(',')}`);
    }
  }

  const emit = (event: NotificationEvent): void => {
    log(
      `needs_you_event kind=${event.kind} ids=${event.ids.join(',')} target=${event.target} count=${event.needs_you}`,
    );
    for (const channel of channels) {
      void deliver(channel, event);
    }
  };

  /** One check. Resolves when its events are handed to the channels; never rejects. */
  async function check(): Promise<void> {
    const startedAt = now();
    let review: ReviewRead;
    try {
      review = await reads.review({ asOf: new Date(startedAt), timeZone: 'UTC' });
    } catch {
      if (!closed) {
        log('needs_you_check_fault');
      }
      return;
    }
    if (closed) {
      return;
    }
    const causes = causesNow();
    const previous = remembered;
    remembered = new Set(review.queue.map(entryKey));
    retiredBefore = startedAt;
    if (previous === null) {
      return;
    }
    const entries: QueueEntry[] = review.queue.filter((entry) => !previous.has(entryKey(entry)));
    if (entries.length === 0) {
      return;
    }
    if (causes.size > 0 && [...causes].every((cause) => cause === RECIPIENT)) {
      log(`needs_you_withheld ids=${entries.map((entry) => entry.id).join(',')}`);
      return;
    }
    let events: NotificationEvent[];
    try {
      events = await buildEvents(entries, review, reads.deliveryTitle);
    } catch {
      if (!closed) {
        log('needs_you_check_fault');
      }
      return;
    }
    if (closed) {
      return;
    }
    for (const event of events) {
      emit(event);
    }
  }

  /** Run one check; when a window closed meanwhile, run the one waiting check after it. */
  async function runCheck(): Promise<void> {
    running = true;
    try {
      await check();
    } catch {
      if (!closed) {
        log('needs_you_check_fault');
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
    const at = now();
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
    boot: runCheck,
    close: () => {
      closed = true;
      waiting = false;
      if (windowTimer !== null) {
        clearTimer(windowTimer);
        windowTimer = null;
      }
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
        mark.lastSuccess = now();
        signal();
      }),
    },
  };
}
