import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { pushStatusQuery, PUSH_QUERY_ROOT } from '../api/push-queries';
import { turnOff, turnOn } from './push-actions';
import type { TurnOnOutcome } from './push-actions';
import { useThisDevice } from './use-this-device';

/** The one-line answer to an action, with a link when it names an address. */
export type PushNotice = { text: string; link?: string };

/** What a Turn on answers, or nothing when the state the page shows next says it. */
export function turnOnNotice(outcome: TurnOnOutcome): PushNotice | undefined {
  switch (outcome.kind) {
    case 'subscribed': {
      return undefined;
    }
    case 'refused': {
      return { link: outcome.link, text: outcome.message };
    }
    case 'failed':
    case 'busy': {
      return { text: outcome.message };
    }
    case 'not_granted': {
      // A denial shows the blocked state, which says how to undo it.
      return outcome.permission === 'denied'
        ? undefined
        : { text: 'Notifications were not turned on. Turn on again to be asked.' };
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/**
 * This browser's notification control (ADR 0045, MMR-711) for any surface
 * that offers it: its state, Turn on and Turn off with their answers, and a
 * busy flag. Every action ends idle and rereads the host and the browser, even
 * when it throws.
 */
export function usePushControl() {
  const client = useQueryClient();
  const thisDevice = useThisDevice();
  const { browser, refresh, state, status } = thisDevice;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<PushNotice | undefined>();

  const reload = async () => {
    await client.invalidateQueries({ queryKey: PUSH_QUERY_ROOT });
    refresh();
  };

  /** Run `action` with the control busy and the last answer cleared. */
  const whileBusy = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const turnOnHere = async () => {
    if (status?.state !== 'ready') {
      return;
    }
    const ready = status;
    // Asking from any surface answers the review page's suggestion (MMR-734).
    browser.answerSuggestion();
    // Started from the click itself: the permission prompt needs the user's activation.
    await whileBusy(async () => {
      const outcome = await turnOn(browser, ready, async () =>
        client.fetchQuery({ ...pushStatusQuery, staleTime: 0 }),
      );
      setNotice(turnOnNotice(outcome));
    });
  };

  const turnOffHere = async () => {
    if (state.kind !== 'on') {
      return;
    }
    const { endpoint } = state.device;
    await whileBusy(async () => {
      try {
        const outcome = await turnOff(browser, endpoint);
        if (outcome.kind === 'busy') {
          setNotice({ text: outcome.message });
        }
      } catch {
        setNotice({ text: "This browser couldn't be turned off. Try again." });
      }
    });
  };

  return {
    ...thisDevice,
    busy,
    notice,
    reload,
    setNotice,
    turnOff: turnOffHere,
    turnOn: turnOnHere,
    whileBusy,
  };
}
