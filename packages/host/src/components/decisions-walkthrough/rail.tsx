import { cn } from '../../lib/cn';
import { CheckGlyph, AgentGlyph, SendGlyph } from './icons';
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
  'flex w-full items-start gap-3 border-b border-line px-2.5 py-3 text-left disabled:cursor-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent enabled:hover:bg-well-850';

/** A rail entry's text: bright and bold when current, dim when reachable, ghosted when not. */
function tone(current: boolean, reachable: boolean): string {
  if (current) {
    return 'font-semibold text-ink-bright';
  }
  return reachable ? 'text-ink-dim' : 'text-ink-ghost';
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
  disabled,
  onGo,
}: {
  entries: readonly RailEntry[];
  step: number;
  hasCheck: boolean;
  checkReady: boolean;
  disabled: boolean;
  onGo: (step: number) => void;
}) {
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
                onClick={() => onGo(index)}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-px grid size-[22px] shrink-0 place-items-center rounded-full',
                    answered && 'bg-attention/15 text-attention-foreground',
                    current &&
                      !answered &&
                      'text-attention-foreground inset-ring-[1.5px] inset-ring-attention',
                    !reachable && 'border border-dashed border-ink-ghost',
                  )}
                >
                  {mark(answered, current)}
                </span>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span
                    className={cn(
                      'text-[13.5px] leading-[1.4] wrap-anywhere',
                      tone(current, reachable),
                    )}
                  >
                    {decision.question}
                  </span>
                  {answered && (
                    <span className="text-[13.5px] leading-[1.4] text-ink-bright wrap-anywhere">
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
              onClick={() => onGo(entries.length)}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-px grid size-[22px] shrink-0 place-items-center',
                  checkReady ? 'text-attention-foreground' : 'text-ink-ghost',
                )}
              >
                <SendGlyph size={12} />
              </span>
              <span
                className={cn(
                  'text-[13.5px] leading-[1.4]',
                  tone(step === entries.length, checkReady),
                )}
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

/** The phone's progress: one segment for each step, done ones dimmer violet, the current one full. */
export function SegmentedBar({ count, step }: { count: number; step: number }) {
  return (
    <div aria-hidden className="flex gap-1 px-4 pt-2.5 md:hidden">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={cn(
            'h-1 flex-1 rounded-sm transition-colors',
            index < step && 'bg-attention/55',
            index === step && 'bg-attention',
            index > step && 'bg-well-800',
          )}
        />
      ))}
    </div>
  );
}
