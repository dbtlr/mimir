import { useId, useRef, useState } from 'react';

import type { PushDevice, PushEventKind } from '../api/fns/push';
import { cn } from '../lib/cn';
import { saveKind } from '../lib/push-actions';
import { HEAL_RUNNING_TEXT, KIND_NAMES, KIND_SAVE_FAILED_TEXT } from '../lib/push-text';
import { usePushBrowser } from '../lib/use-push-browser';
import { PUSH_EVENT_KINDS } from '../server/push-states';
import { Switch } from './ui/switch';

/*
 * The four switches that choose which kinds notify one browser (ADR 0045,
 * MMR-712): this browser's group on the Notifications page, and another
 * row's sheet or dialog. A switch saves its one kind when it flips; it shows
 * the new position and is disabled until the host answers, and returns with a
 * sentence when the save fails.
 */

export type KindSwitchesProps = {
  device: PushDevice;
  /** This browser's own row: a save waits for a running heal and keeps the record. */
  own: boolean;
  /** The page is running Turn on, Turn off, or a reset. */
  disabled?: boolean;
  /** A save landed: the page applies that one kind's change to the row it shows. */
  onSaved: (endpoint: string, kind: PushEventKind, muted: boolean) => void;
  /** The host no longer holds the row. */
  onGone: () => void;
  /** Whether any save is running, for the page to hold Turn off and Reset. */
  onSavingChange?: (saving: boolean) => void;
  /** The list's own classes: a card on the page, a bordered block in a sheet or dialog. */
  className?: string;
  /** A line under the switches before the page's answers, such as the badge's. */
  footnote?: string;
  /** The line when every kind is off, naming this browser or the row's. */
  everyOffText: string;
};

export function KindSwitches({
  device,
  own,
  disabled = false,
  onSaved,
  onGone,
  onSavingChange,
  className,
  footnote,
  everyOffText,
}: KindSwitchesProps) {
  const browser = usePushBrowser();
  const nameId = useId();
  /** Each running save's kind and the position it shows. */
  const [pending, setPending] = useState<Partial<Record<PushEventKind, boolean>>>({});
  const [failure, setFailure] = useState<string | undefined>();
  const saving = useRef(0);

  const mutedNow = (kind: PushEventKind) => pending[kind] ?? device.muted.includes(kind);
  const everyOff = PUSH_EVENT_KINDS.every(mutedNow);

  const track = (step: 1 | -1) => {
    saving.current += step;
    onSavingChange?.(saving.current > 0);
  };

  const flip = async (kind: PushEventKind, notify: boolean) => {
    const muted = !notify;
    setFailure(undefined);
    setPending((running) => ({ ...running, [kind]: muted }));
    track(1);
    try {
      const answer = await saveKind(browser, {
        endpoint: device.endpoint,
        kind,
        muted,
        own,
        rowMuted: device.muted,
      });
      if (answer.state === 'saved') {
        onSaved(device.endpoint, kind, muted);
      } else if (answer.state === 'not_found') {
        onGone();
      } else {
        setFailure(answer.state === 'busy' ? HEAL_RUNNING_TEXT : KIND_SAVE_FAILED_TEXT);
      }
    } catch {
      setFailure(KIND_SAVE_FAILED_TEXT);
    } finally {
      setPending((running) => {
        const { [kind]: _settled, ...rest } = running;
        return rest;
      });
      track(-1);
    }
  };

  return (
    <>
      <ul className={cn('divide-y divide-line', className)}>
        {PUSH_EVENT_KINDS.map((kind) => (
          <li key={kind}>
            {/* The row is the switch's label, so tapping its text flips it (ADR 0019, MMR-712). */}
            <label className="flex min-h-11 cursor-pointer items-center gap-3 px-4 py-2">
              <span id={`${nameId}-${kind}`} className="flex-1 text-body text-ink-bright">
                {KIND_NAMES[kind]}
              </span>
              <Switch
                aria-labelledby={`${nameId}-${kind}`}
                checked={!mutedNow(kind)}
                disabled={disabled || pending[kind] !== undefined}
                onCheckedChange={(notify) => void flip(kind, notify)}
              />
            </label>
          </li>
        ))}
      </ul>
      {footnote !== undefined && <p className="px-1 text-xs text-ink-dim">{footnote}</p>}
      <div
        aria-live="polite"
        className="flex flex-col gap-1 px-1 text-xs text-ink-dim empty:hidden"
      >
        {failure !== undefined && <p className="font-medium text-ink-bright">{failure}</p>}
        {everyOff && <p>{everyOffText}</p>}
      </div>
    </>
  );
}
