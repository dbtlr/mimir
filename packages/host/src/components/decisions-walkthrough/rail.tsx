import { cn } from '../../lib/cn';
import { isRepeatClick, useWalkthroughBusy } from '../patterns/walkthrough';
import { AgentGlyph, CheckGlyph, SendGlyph } from './icons';
import { answerText, verdictOf } from './model';
import type { Selection, WalkDecision } from './model';
import { Outcome } from './parts';

/** The rail's view of one decision. */
export type RailEntry = {
  decision: WalkDecision;
  selection: Selection;
  answered: boolean;
  gone: boolean;
};

const BUTTON_CLASS =
  'flex w-full items-start gap-3 border-b border-line px-3 py-3 text-left disabled:cursor-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent enabled:hover:bg-well-850';

/** A rail entry's text: bright and bold when current, ink when reachable, dim when not (still 4.5:1). */
function tone(current: boolean, reachable: boolean): string {
  if (current) {
    return 'font-semibold text-ink-bright';
  }
  return reachable ? 'text-ink' : 'text-ink-dim';
}

/** A decision's mark in the rail: a check once answered, the agent's mark while current. */
function mark(answered: boolean, current: boolean) {
  if (answered) {
    return <CheckGlyph size={13} />;
  }
  return current ? <AgentGlyph size={12} /> : null;
}

/**
 * The rail beside the steps (md and up): an answered decision shows a check,
 * its outcome, and its answer, and opens its step again; the current one is
 * marked in attention violet; later ones are dimmed and disabled. The last
 * entry is the check step, when the set has one.
 */
export function Rail({
  entries,
  step,
  hasCheck,
  checkReady,
  onGo,
}: {
  entries: readonly RailEntry[];
  step: number;
  hasCheck: boolean;
  checkReady: boolean;
  onGo: (step: number) => void;
}) {
  // A Send holds the rail with the rest of the layer.
  const disabled = useWalkthroughBusy();
  return (
    <nav
      aria-label="Decisions"
      className="w-[300px] flex-none overflow-y-auto border-r border-line bg-well-recessed px-3 py-2 max-md:hidden"
    >
      <ol>
        {entries.map(({ decision, selection, answered, gone }, index) => {
          const current = index === step;
          const reachable = answered || current;
          const verdict = verdictOf(decision, selection);
          return (
            <li key={decision.id} className={cn(current && 'bg-attention/[0.07]')}>
              <button
                type="button"
                className={BUTTON_CLASS}
                disabled={!reachable || disabled}
                aria-current={current ? 'step' : undefined}
                onClick={(event) => {
                  if (!isRepeatClick(event)) {
                    onGo(index);
                  }
                }}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-px grid size-[22px] shrink-0 place-items-center rounded-full',
                    answered && 'bg-attention/15 text-attention-foreground',
                    current &&
                      !answered &&
                      'text-attention-foreground inset-ring-[1.5px] inset-ring-attention',
                    !reachable && 'border border-dashed border-ink-faint',
                  )}
                >
                  {mark(answered, current)}
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span
                    className={cn('text-meta leading-5 wrap-anywhere', tone(current, reachable))}
                  >
                    {decision.question}
                  </span>
                  {answered && (
                    <span className="text-meta leading-5 text-ink-bright wrap-anywhere">
                      {gone ? (
                        'No longer waits on you'
                      ) : (
                        <>
                          <Outcome confirmed={verdict === 'confirm'} />
                          {answerText(decision, selection)}
                        </>
                      )}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
        {hasCheck && (
          <li className={cn(step === entries.length && 'bg-attention/[0.07]')}>
            <button
              type="button"
              className={BUTTON_CLASS}
              disabled={!checkReady || disabled}
              aria-current={step === entries.length ? 'step' : undefined}
              onClick={(event) => {
                if (!isRepeatClick(event)) {
                  onGo(entries.length);
                }
              }}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-px grid size-[22px] shrink-0 place-items-center',
                  checkReady ? 'text-attention-foreground' : 'text-ink-faint',
                )}
              >
                <SendGlyph size={12} />
              </span>
              <span
                className={cn('text-meta leading-5', tone(step === entries.length, checkReady))}
              >
                Check and send
              </span>
            </button>
          </li>
        )}
      </ol>
    </nav>
  );
}
