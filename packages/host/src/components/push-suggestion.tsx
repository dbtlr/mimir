import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { focusMain } from '../lib/focus-main';
import { couldSuggestTurningOn, suggestsTurningOn } from '../lib/push-this-device';
import { usePushBrowser } from '../lib/use-push-browser';
import { usePushControl } from '../lib/use-push-control';
import { ConfirmCard } from './ui/confirm-card';

/*
 * The review page's one-time card suggesting notifications (ADR 0045,
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
  const answered = answer !== 'open';
  const gone = answer === 'gone' || (answer === 'turning_on' && !busy && notice === undefined);

  // An answer that removes the card takes the focused button with it: hand focus to the page.
  useEffect(() => {
    if (answered && gone && document.activeElement === document.body) {
      focusMain();
    }
  }, [answered, gone]);

  if (gone) {
    return null;
  }

  if (answer === 'open') {
    if (!suggestsTurningOn(control.state, control.browser.snapshot())) {
      return null;
    }
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
            control.browser.answerSuggestion();
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
