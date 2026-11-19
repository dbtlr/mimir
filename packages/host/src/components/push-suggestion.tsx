import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { answerSuggestion, suggestionAnswered } from '../lib/push-suggestion';
import { couldSuggestTurningOn, suggestsTurningOn } from '../lib/push-this-device';
import { usePushBrowser } from '../lib/use-push-browser';
import { usePushControl } from '../lib/use-push-control';
import { ConfirmCard } from './ui/confirm-card';

/*
 * Home's one-time card suggesting notifications (ADR 0045, MMR-734). It shows
 * only when Turn on would work right away from a tap, and Turn on or Not now
 * retires it in this browser for good. Settings › Notifications stays the
 * place for every other state.
 */

const TITLE = 'Get notified when something needs you';

/** How far this load got with the card: unanswered, turned on, or put away. */
type Answer = 'open' | 'turning_on' | 'gone';

/**
 * The card, when this browser could take it. Whether it could is read once at
 * mount from the browser alone, so a browser that cannot asks the host nothing,
 * and an answer given in this load keeps the card up to show its outcome.
 */
export function PushSuggestion({ offline }: { offline: boolean }) {
  const browser = usePushBrowser();
  const [eligible] = useState(
    () => couldSuggestTurningOn(browser.snapshot()) && !suggestionAnswered(),
  );
  return eligible ? <PushSuggestionCard offline={offline} /> : null;
}

function PushSuggestionCard({ offline }: { offline: boolean }) {
  const control = usePushControl();
  const [answer, setAnswer] = useState<Answer>('open');

  if (answer === 'gone') {
    return null;
  }

  if (answer === 'open') {
    if (!suggestsTurningOn(control.state, control.browser.snapshot())) {
      return null;
    }
    return (
      <ConfirmCard
        title={TITLE}
        size="default"
        confirm={{
          disabled: offline,
          label: 'Turn on',
          onClick: () => {
            answerSuggestion();
            setAnswer('turning_on');
            // Called from the click itself: the permission prompt needs the user's activation.
            void control.turnOn();
          },
        }}
        cancel={{
          disabled: offline,
          label: 'Not now',
          onClick: () => {
            answerSuggestion();
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
  const { busy, notice } = control;
  if (!busy && notice === undefined) {
    return null;
  }
  return (
    <ConfirmCard
      title={TITLE}
      size="default"
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
              Open Settings › Notifications
            </Link>
          </p>
        )
      }
      cancel={
        busy
          ? undefined
          : {
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
