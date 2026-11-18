import type { Ref } from 'react';

import { checkEffect, sendLabel, sendLine } from './copy';
import { CheckGlyph, SendGlyph } from './icons';
import { answerText, noteOf, verdictOf } from './model';
import type { Selection, WalkDecision } from './model';
import {
  BackButton,
  Composer,
  MetaLine,
  Outcome,
  PrimaryButton,
  Scroll,
  ScreenHeading,
  TextButton,
} from './parts';

/** One decision to check: its place in the set, and what the operator chose for it. */
export type CheckEntry = { index: number; decision: WalkDecision; selection: Selection };

/**
 * "Check your answers" (ADR 0019, MMR-703 refinement): each answer to be sent
 * with its outcome, note, and effect, a Change link back to its step, and the
 * one Send. A decision that left the live read is not listed and not sent.
 */
export function CheckStep({
  entries,
  delivery,
  headingRef,
  writing,
  offline,
  onChange,
  onBack,
  onSend,
}: {
  entries: readonly CheckEntry[];
  delivery: string | null;
  headingRef: Ref<HTMLHeadingElement>;
  writing: boolean;
  offline: boolean;
  onChange: (index: number) => void;
  onBack: () => void;
  onSend: () => void;
}) {
  return (
    <section aria-label="Check your answers" className="flex min-h-0 flex-1 flex-col">
      <Scroll>
        <MetaLine>
          <span className="flex items-center gap-1.5 font-semibold text-attention-foreground">
            <SendGlyph />
            Before you send
          </span>
        </MetaLine>
        <ScreenHeading headingRef={headingRef} className="mb-2.5 text-[21px] md:text-[24px]">
          Check your answers
        </ScreenHeading>
        <ol className="mt-2 border-t border-line">
          {entries.map(({ index, decision, selection }) => {
            const verdict = verdictOf(decision, selection);
            const note = noteOf(selection);
            return (
              <li key={decision.id} className="flex items-start gap-3 border-b border-line py-3.5">
                <span className="mt-px grid size-[22px] shrink-0 place-items-center rounded-full bg-attention/15 text-attention-foreground">
                  <CheckGlyph size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-body text-ink-dim wrap-anywhere">{decision.question}</p>
                  <p className="my-1 text-[15px] leading-[1.45] font-medium text-ink-bright wrap-anywhere">
                    <Outcome confirmed={verdict === 'confirm'} />
                    {answerText(decision, selection)}
                  </p>
                  {verdict !== 'custom' && note !== '' && (
                    <p className="my-1.5 border-l-2 border-line-bright pl-2.5 text-body whitespace-pre-wrap text-ink wrap-anywhere">
                      {note}
                    </p>
                  )}
                  <p className="text-meta text-ink-faint">{checkEffect(verdict, decision.tasks)}</p>
                </div>
                <TextButton
                  disabled={writing}
                  aria-label={`Change your answer to ${decision.id}`}
                  onClick={() => onChange(index)}
                >
                  Change
                </TextButton>
              </li>
            );
          })}
        </ol>
        <p className="mt-[18px] rounded-lg border border-line bg-well-850 px-3.5 py-3 text-body text-ink">
          {sendLine(delivery)}
        </p>
      </Scroll>
      <Composer>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-2 md:grid-cols-[auto_minmax(0,1fr)_auto]">
          <BackButton disabled={writing} onClick={onBack} />
          <PrimaryButton disabled={writing || offline || entries.length === 0} onClick={onSend}>
            {sendLabel(entries.length)}
          </PrimaryButton>
        </div>
      </Composer>
    </section>
  );
}
