import { toast } from 'sonner';

import type { T3LaunchInput, T3LaunchResult } from '../api/fns/t3';
import { t3ThreadLink } from '../lib/t3-link';
import type { T3ThreadHandles } from '../lib/t3-link';

/** Open an Open in T3 link in place: T3's app link hands off to the T3 app. */
const openLink = (link: string) => () => {
  window.open(link, '_self');
};

const openAction = (origin: string, handles: T3ThreadHandles) => {
  const link = t3ThreadLink(origin, handles);
  return link === null ? undefined : { label: 'Open in T3', onClick: openLink(link) };
};

/** The words for an answer that leaves the control to Reconnect or Devices. */
function unavailableMessage(
  answer: Extract<T3LaunchResult, { state: 'unconfigured' | 'misconfigured' | 'disconnected' }>,
) {
  switch (answer.state) {
    case 'disconnected': {
      return 'The T3 connection ended. Reconnect T3 to launch.';
    }
    case 'misconfigured': {
      return `T3 is not set up: ${answer.setting} is ${answer.problem}.`;
    }
    case 'unconfigured': {
      return 'T3 is not configured.';
    }
    default: {
      return 'T3 is unavailable.';
    }
  }
}

/** The words for an `invalid` answer, by the field it names. */
function invalidMessage(field: Extract<T3LaunchResult, { state: 'invalid' }>['field']) {
  switch (field) {
    case 'attempt': {
      return 'This launch could not be sent; launch again';
    }
    case 'branch': {
      return 'The branch name is not valid. T3’s options did not change.';
    }
    default: {
      return 'T3’s options changed; check the settings';
    }
  }
}

/**
 * Say what a launch answered (ADR 0040, Launch). Only `unreachable` and
 * `not_queued` offer a Retry, which sends the same input, attempt included.
 */
export function announceLaunch(
  answer: T3LaunchResult,
  input: T3LaunchInput,
  context: { origin: string; retry: () => void },
): void {
  const { origin, retry } = context;
  const retryAction = { label: 'Retry', onClick: retry };
  switch (answer.state) {
    case 'launched': {
      toast.success(`Launched on ${answer.label}. ${input.task} is queued.`, {
        action: openAction(origin, {
          harness: 't3',
          host: answer.environmentId,
          session: answer.threadId,
        }),
      });
      return;
    }
    case 'not_queued': {
      toast.error(
        `The thread started on ${answer.label}, but ${input.task} was not queued: ${answer.message}`,
        {
          action: retryAction,
          cancel: openAction(origin, {
            harness: 't3',
            host: answer.environmentId,
            session: answer.threadId,
          }),
        },
      );
      return;
    }
    case 'unreachable': {
      toast.error('T3 did not answer.', { action: retryAction });
      return;
    }
    case 'taken': {
      // The holder may be the operator's own launch, in a T3 thread.
      const message =
        answer.harness === 't3'
          ? 'Already queued for a T3 thread'
          : 'Already queued for another session';
      const action = openAction(origin, answer);
      if (action === undefined) {
        toast.error(message);
      } else {
        toast.error(message, { action });
      }
      return;
    }
    case 'not_ready': {
      toast.error('This task can no longer be launched');
      return;
    }
    case 'invalid': {
      toast.error(invalidMessage(answer.field));
      return;
    }
    case 'refused': {
      toast.error('T3 refused the launch');
      return;
    }
    default: {
      toast.error(unavailableMessage(answer));
    }
  }
}
