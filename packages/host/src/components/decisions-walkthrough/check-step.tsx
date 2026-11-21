import {
  WalkthroughBack,
  WalkthroughBar,
  WalkthroughBody,
  WalkthroughCommit,
  WalkthroughHeading,
  WalkthroughRow,
  useWalkthroughBusy,
} from '../patterns/walkthrough';
import { SENDING, checkEffect, sendLabel, sendLine } from './copy';
import { CheckGlyph, SendGlyph } from './icons';
import { answerText, isBlankCustom, noteOf, verdictOf } from './model';
import type { Selection, WalkDecision } from './model';
import { MetaLine, Outcome, TextButton } from './parts';

/** One decision to check: its place in the set, and what the operator chose for it. */
export type CheckEntry = { index: number; decision: WalkDecision; selection: Selection };

/**
 * "Check your answers" (ADR 0019, MMR-703 refinement): each answer to be sent
 * with its outcome, note, and effect, a Change link back to its step, and the
 * one Send. A decision that left the live read is not listed and not sent,
 * and a blank "Something else" holds Send back.
 */
export function CheckStep({
  entries,
  delivery,
  offline,
  onChange,
  onBack,
  onSend,
}: {
  entries: readonly CheckEntry[];
  delivery: string | null;
  offline: boolean;
  onChange: (index: number) => void;
  onBack: () => void;
  /** Write the answers; the write's promise holds the layer, and a refusal returns focus to Send. */
  onSend: () => Promise<void>;
}) {
  const busy = useWalkthroughBusy();
  const blank = entries.find(({ selection }) => isBlankCustom(selection));
  return (
    <section aria-label="Check your answers" className="flex min-h-0 flex-1 flex-col">
      <WalkthroughBody>
        <MetaLine>
          <span className="flex items-center gap-1.5 font-semibold text-attention-foreground">
            <SendGlyph />
            Before you send
          </span>
        </MetaLine>
        <WalkthroughHeading className="mb-3">Check your answers</WalkthroughHeading>
        <ol className="mt-2 border-t border-line">
          {entries.map(({ index, decision, selection }) => {
            const verdict = verdictOf(decision, selection);
            const note = noteOf(selection);
            return (
              <li key={decision.id} className="flex items-start gap-3 border-b border-line py-4">
                <span className="mt-px grid size-[22px] shrink-0 place-items-center rounded-full bg-attention/15 text-attention-foreground">
                  <CheckGlyph size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-body text-ink-dim wrap-anywhere">{decision.question}</p>
                  <p className="my-1 text-[15px] leading-[22px] font-medium text-ink-bright wrap-anywhere">
                    <Outcome confirmed={verdict === 'confirm'} />
                    {answerText(decision, selection)}
                  </p>
                  {verdict !== 'custom' && note !== '' && (
                    <p className="my-2 border-l-2 border-line-bright pl-3 text-body whitespace-pre-wrap text-ink wrap-anywhere">
                      {note}
                    </p>
                  )}
                  <p className="text-meta text-ink-dim">{checkEffect(verdict, decision.tasks)}</p>
                </div>
                <TextButton
                  disabled={busy}
                  aria-label={`Change your answer to ${decision.id}`}
                  onClick={() => onChange(index)}
                >
                  Change
                </TextButton>
              </li>
            );
          })}
        </ol>
        <p className="mt-5 rounded-lg border border-line bg-well-850 px-4 py-3 text-body text-ink">
          {sendLine(delivery)}
        </p>
      </WalkthroughBody>
      <WalkthroughBar>
        {blank !== undefined && (
          <p className="text-meta text-ink-dim">
            {`Write your own answer to "${blank.decision.question}", or pick another answer, before sending.`}
          </p>
        )}
        <WalkthroughRow>
          <WalkthroughBack onClick={onBack} />
          <WalkthroughCommit
            disabled={offline || blank !== undefined || entries.length === 0}
            onCommit={onSend}
            pendingLabel={SENDING}
          >
            {sendLabel(entries.length)}
          </WalkthroughCommit>
        </WalkthroughRow>
      </WalkthroughBar>
    </section>
  );
}
