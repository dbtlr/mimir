import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { focusMain } from '../lib/focus-main';
import { couldSuggestTurningOn, suggestsTurningOn } from '../lib/push-this-device';
import { usePushBrowser } from '../lib/use-push-browser';
import { usePushControl } from '../lib/use-push-control';
import { ConfirmCard } from './ui/confirm-card';

/*
 * Home's one-time card suggesting notifications (ADR 0045,
 * MMR-734). It shows only when Turn on would work right away from a tap, and
 * Turn on or Not now retires it in this browser for good. Settings ›
 * Notifications stays the place for every other state.
 */

const TITLE = 'Get notified when something needs you';

/** How far this mount got with the card: unanswered, turned on, or put away. */
type Answer = 'open' | 'turning_on' | 'gone';

/**
 * The card, when this browser could take it. Whether it could is read at
 * mount from the browser alone, so a browser that cannot asks the host
 * nothing, and an answer given while the page is open keeps the card up to
 * show its outcome.
 */
export function PushSuggestion({ offline }: { offline: boolean }) {
  const browser = usePushBrowser();
  const [eligible] = useState(
    () => couldSuggestTurningOn(browser.snapshot()) && !browser.suggestionAnswered(),
  );
  return eligible ? <PushSuggestionCard offline={offline} /> : null;
}

function PushSuggestionCard({ offline }: { offline: boolean }) {
  const control = usePushControl();
  const [answer, setAnswer] = useState<Answer>('open');
  const frame = useRef<HTMLElement>(null);
  const { busy, notice } = control;
  const { browser } = control;
  // Read live: another tab may answer while this one is open, or before the host's status loads.
  const answeredElsewhere = useSyncExternalStore(
    browser.watchSuggestion,
    browser.suggestionAnswered,
    () => false,
  );
  const gone = answer === 'gone' || (answer === 'turning_on' && !busy && notice === undefined);
  const visible =
    !gone &&
    (answer !== 'open' ||
      (!answeredElsewhere && suggestsTurningOn(control.state, browser.snapshot())));

  // Whether focus sits in the card, so its leaving moves only the focus it took with it.
  const holdsFocus = useRef(false);
  useEffect(() => {
    const shown = frame.current;
    if (!visible || shown === null) {
      return undefined;
    }
    holdsFocus.current = shown.contains(document.activeElement);
    const enter = () => {
      holdsFocus.current = true;
    };
    const leave = () => {
      // Read once the move settles. A browser may blur a focused control as the card is
      // removed; a card that is gone still holds the focus it dropped.
      queueMicrotask(() => {
        if (shown.isConnected) {
          holdsFocus.current = shown.contains(document.activeElement);
        }
      });
    };
    shown.addEventListener('focusin', enter);
    shown.addEventListener('focusout', leave);
    return () => {
      shown.removeEventListener('focusin', enter);
      shown.removeEventListener('focusout', leave);
    };
  }, [visible]);

  // A card that leaves holding focus takes the focused control with it: hand focus to the page.
  useEffect(() => {
    if (!visible && holdsFocus.current) {
      holdsFocus.current = false;
      if (document.activeElement === document.body) {
        focusMain();
      }
    }
  }, [visible]);

  if (!visible) {
    return null;
  }

  if (answer === 'open') {
    return (
      <ConfirmCard
        ref={frame}
        title={TITLE}
        // Needs you leads the page, so the suggestion takes no solid button (ADR 0019 §1).
        confirm={{
          disabled: offline,
          label: 'Turn on',
          onClick: () => {
            setAnswer('turning_on');
            // Called from the click itself: the permission prompt needs the user's activation.
            // Turn on records the answer in this browser.
            void control.turnOn();
            // The buttons leave while it runs: keep focus in the card.
            frame.current?.focus();
          },
          variant: 'outline',
        }}
        cancel={{
          disabled: offline,
          label: 'Not now',
          onClick: () => {
            browser.answerSuggestion();
            setAnswer('gone');
          },
        }}
      >
        This browser shows a notification when a record waits on you. You can turn it off any time
        in Settings › Notifications.
      </ConfirmCard>
    );
  }

  // Turning on: the card stays while it runs, and afterwards only to say why it did not work.
  return (
    <ConfirmCard
      ref={frame}
      title={TITLE}
      notice={
        notice !== undefined && (
          <p className="flex flex-col gap-1">
            <span>
              {notice.text}
              {notice.link !== undefined && (
                <>
                  {' '}
                  <a href={notice.link} className="text-accent underline">
                    {notice.link}
                  </a>
                </>
              )}
            </span>
            <Link to="/settings/notifications" className="text-accent underline">
              Turn on in Settings › Notifications
            </Link>
          </p>
        )
      }
      cancel={
        busy
          ? undefined
          : {
              autoFocus: true,
              label: 'Close',
              onClick: () => {
                setAnswer('gone');
              },
            }
      }
    >
      {busy ? 'Turning notifications on…' : undefined}
    </ConfirmCard>
  );
}
