import type { T3WakeField, T3WakeInput, T3WakeState } from '../api/fns/deliveries';
import { toast } from './patterns/notice';
import { openAction } from './t3-launch-answers';

/** What a wake's toast offers: each action is the console's own flow, never a T3 operation. */
export type WakeAnnouncement = {
  /** The configured T3 origin, null when the feature is off. */
  origin: string | null;
  /** Resend the wake through `wakeT3` with a state's `retry`. */
  retry: (input: T3WakeInput) => void;
  /** Start Connect T3, as Reconnect T3 does on the Connections page. */
  reconnect: () => void;
  /** Go to the Connections page, where T3's settings are shown. */
  openConnections: () => void;
};

/** The words for the field a Retry's `invalid` names. */
function invalidMessage(field: T3WakeField): string {
  switch (field) {
    case 'attempt': {
      return 'The T3 thread could not be told again; act again to tell it.';
    }
    case 'decision': {
      return 'The T3 thread could not be told: the decision does not belong to that delivery.';
    }
    case 'delivery': {
      return 'The T3 thread could not be told: the delivery is not valid.';
    }
    case 'since': {
      return 'The T3 thread could not be told: the time of the action is not valid.';
    }
    default: {
      return 'The T3 thread could not be told: the action is not one that tells it.';
    }
  }
}

const NOT_TOLD = 'Saved. The T3 thread was not told';

/**
 * Say what a wake answered (ADR 0040, the wake). A sent or skipped wake says
 * nothing. The others say the write was saved and the thread was not told, and
 * why; only `unreachable` and `failed` offer Retry, with the state's `retry`.
 */
export function announceWake(wake: T3WakeState, context: WakeAnnouncement): void {
  const { origin, reconnect, retry } = context;
  switch (wake.state) {
    case 'sent':
    case 'skipped': {
      return;
    }
    case 'misconfigured': {
      toast.warning(`${NOT_TOLD}: T3 is not set up correctly.`, {
        action: { label: 'Connections', onClick: context.openConnections },
      });
      return;
    }
    case 'disconnected': {
      toast.warning(`${NOT_TOLD}: connect T3 again.`, {
        action: { label: 'Reconnect T3', onClick: reconnect },
      });
      return;
    }
    case 'unreachable': {
      toast.warning(`${NOT_TOLD}: T3 did not answer.`, {
        action: {
          label: 'Retry',
          onClick: () => {
            retry(wake.retry);
          },
        },
      });
      return;
    }
    case 'refused': {
      // T3 refuses a send to a thread with broader modes than Mimir's connection.
      const message = `${NOT_TOLD}: T3 refused the message. The thread may run with more access than Mimir’s T3 connection; reconnect T3 with full access.`;
      const action = openAction(origin ?? '', { harness: 't3', ...wake.thread });
      toast.warning(message, {
        cancel: { label: 'Reconnect T3', onClick: reconnect },
        ...(origin === null || action === undefined ? {} : { action }),
      });
      return;
    }
    case 'failed': {
      toast.warning(`${NOT_TOLD}.`, {
        action: {
          label: 'Retry',
          onClick: () => {
            retry(wake.retry);
          },
        },
      });
      return;
    }
    default: {
      toast.error(invalidMessage(wake.field));
    }
  }
}
