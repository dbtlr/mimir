import { useId } from 'react';
import type { Ref } from 'react';

import { ago } from '../../lib/time';
import { GrowingTextarea } from '../ui/growing-textarea';
import { effectLine, stepButtonLabel } from './copy';
import type { StepTarget } from './copy';
import { AgentGlyph } from './icons';
import { isBlankCustom, optionDetail, verdictOf } from './model';
import type { Selection, WalkDecision } from './model';
import { BackButton, Composer, MetaLine, PrimaryButton, Scroll, ScreenHeading } from './parts';

/** The flags beside an option: "Agent's answer" in attention violet, "Agent recommends" in dim ink. */
function Flags({ decision, number }: { decision: WalkDecision; number: number }) {
  return (
    <>
      {number === decision.taken && (
        <span className="text-tag font-semibold text-attention-foreground">Agent's answer</span>
      )}
      {number === decision.recommended && decision.recommended !== decision.taken && (
        <span className="text-tag font-semibold text-ink-dim">Agent recommends</span>
      )}
    </>
  );
}

const ROW_CLASS =
  'flex min-h-12 cursor-pointer items-start gap-3 border-b border-line px-1 py-3 has-[:focus-visible]:rounded-md has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent';
const RADIO_CLASS =
  'mt-[3px] size-[18px] shrink-0 appearance-none rounded-full border-[1.5px] border-ink-faint outline-none checked:border-attention checked:bg-attention checked:shadow-[inset_0_0_0_3.5px_var(--color-well-900)]';

/**
 * The answers: a native radio group, one row per option and a last row for
 * the operator's own words, whose text box shows under the group.
 */
function Answers({
  decision,
  selection,
  disabled,
  onChange,
}: {
  decision: WalkDecision;
  selection: Selection;
  disabled: boolean;
  onChange: (patch: Partial<Selection>) => void;
}) {
  const group = useId();
  return (
    <>
      <div
        role="radiogroup"
        aria-label={`Your answer to ${decision.id}`}
        className="mb-0 border-t border-line"
      >
        {decision.options.map((text, index) => {
          const number = index + 1;
          const picked = selection.choice === number;
          const detail = optionDetail(decision, number);
          const optionText = (
            <span
              className={`flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[15.5px] leading-[1.45] wrap-anywhere ${picked ? 'text-ink-bright' : 'text-ink'}`}
            >
              <span>{text}</span>
              <Flags decision={decision} number={number} />
            </span>
          );
          if (detail === null) {
            return (
              <label key={number} className={ROW_CLASS}>
                <input
                  type="radio"
                  name={group}
                  className={RADIO_CLASS}
                  checked={picked}
                  disabled={disabled}
                  onChange={() => onChange({ choice: number })}
                />
                {optionText}
              </label>
            );
          }
          // The detail stays out of the label so the radio's name does not gain it;
          // aria-describedby reads it after the name, and a click on it selects the option.
          const radioId = `${group}-${String(number)}`;
          const detailId = `${radioId}-detail`;
          return (
            <div key={number} className={ROW_CLASS}>
              <input
                id={radioId}
                type="radio"
                name={group}
                className={RADIO_CLASS}
                aria-describedby={detailId}
                checked={picked}
                disabled={disabled}
                onChange={() => onChange({ choice: number })}
              />
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={radioId} className="cursor-pointer">
                  {optionText}
                </label>
                {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- the radio is the keyboard path; this click only mirrors the label */}
                <p
                  id={detailId}
                  className={`text-meta leading-[1.45] whitespace-pre-line text-ink-dim wrap-anywhere ${picked ? '' : 'line-clamp-2 md:line-clamp-3'}`}
                  onClick={() => {
                    if (!disabled) {
                      onChange({ choice: number });
                    }
                  }}
                >
                  {detail}
                </p>
              </div>
            </div>
          );
        })}
        <label className={ROW_CLASS}>
          <input
            type="radio"
            name={group}
            className={RADIO_CLASS}
            checked={selection.choice === 'custom'}
            disabled={disabled}
            onChange={() => onChange({ choice: 'custom' })}
          />
          <span className="text-[15.5px] leading-[1.45] text-ink-dim">Something else</span>
        </label>
      </div>
      {selection.choice === 'custom' && (
        <div className="pt-2.5 pb-1">
          <GrowingTextarea
            aria-label="Your own answer"
            placeholder="The answer you want"
            value={selection.answer}
            disabled={disabled}
            onChange={(event) => onChange({ answer: event.target.value })}
          />
        </div>
      )}
    </>
  );
}

/** The tasks built on the answer taken, each with its id and title. */
function BuiltOn({
  tasks,
  titles,
}: {
  tasks: readonly string[];
  titles: ReadonlyMap<string, string>;
}) {
  if (tasks.length === 0) {
    return null;
  }
  return (
    <div className="mt-[18px]">
      <p className="mb-1 text-meta font-semibold text-ink-dim">Built on this answer</p>
      <ul className="flex flex-col">
        {tasks.map((id) => (
          <li key={id} className="flex items-baseline gap-2.5 py-[3px] text-body">
            <span className="font-mono text-mono-id text-ink-faint">{id}</span>
            {titles.has(id) && <span className="text-ink wrap-anywhere">{titles.get(id)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The step button's label when the decision left the live read: there is nothing to answer. */
function goneLabel(target: StepTarget): string {
  if (target === 'send') {
    return 'Nothing to send';
  }
  return target === 'review' ? 'Review' : 'Continue';
}

/**
 * One decision as the agent's briefing (ADR 0019, MMR-703 refinement): meta
 * line, question, what it took, why, the answers, the tasks built on it, then
 * the reply bar. A decision that left the live read says so in place of its
 * answers and its reply bar.
 */
export function Step({
  decision,
  gone,
  selection,
  titles,
  headingRef,
  target,
  first,
  writing,
  offline,
  onChange,
  onBack,
  onNext,
}: {
  decision: WalkDecision;
  gone: boolean;
  selection: Selection;
  titles: ReadonlyMap<string, string>;
  headingRef: Ref<HTMLHeadingElement>;
  target: StepTarget;
  first: boolean;
  writing: boolean;
  offline: boolean;
  onChange: (patch: Partial<Selection>) => void;
  onBack: () => void;
  /** Move on, or write for a lone decision; `control` is the button, which takes focus back if the write fails. */
  onNext: (control: HTMLElement) => void;
}) {
  const taken = decision.options[decision.taken - 1] ?? '';
  const recommended = decision.options[decision.recommended - 1];
  const verdict = verdictOf(decision, selection);
  const custom = selection.choice === 'custom';
  const commits = target === 'send';
  const blocked = gone ? commits : isBlankCustom(selection) || (commits && offline) || writing;
  const label = gone ? goneLabel(target) : stepButtonLabel(verdict, target);
  return (
    <section aria-label={`Decision ${decision.id}`} className="flex min-h-0 flex-1 flex-col">
      <Scroll>
        <MetaLine>
          <span className="flex items-center gap-1.5 font-semibold text-attention-foreground">
            <AgentGlyph />
            Agent
          </span>
          <span className="capitalize">{decision.class}</span>
          <span>{ago(decision.created_at)}</span>
          <span className="font-mono text-mono-id">{decision.id}</span>
        </MetaLine>
        <ScreenHeading
          headingRef={headingRef}
          className="mb-2.5 text-header leading-[1.28] md:text-[24px]"
        >
          {decision.question}
        </ScreenHeading>
        <p className="mb-1.5 text-ink">
          It took <strong className="font-semibold text-ink-bright">{taken}</strong> and kept
          building.
          {recommended !== undefined && decision.recommended !== decision.taken && (
            <>
              {' '}
              It recommends <strong className="font-semibold text-ink-bright">{recommended}</strong>
              .
            </>
          )}
        </p>
        {decision.why !== null && decision.why !== '' && (
          <p className="mb-[18px] max-w-[62ch] text-[14.5px] text-ink-dim">{decision.why}</p>
        )}
        {gone ? (
          <p
            role="status"
            className="mt-3 rounded-lg border border-line bg-well-850 p-3 text-body text-ink-dim"
          >
            This decision no longer waits on you
          </p>
        ) : (
          <Answers
            decision={decision}
            selection={selection}
            disabled={writing}
            onChange={onChange}
          />
        )}
        <BuiltOn tasks={decision.tasks} titles={titles} />
      </Scroll>
      <Composer>
        {!gone && (
          <p className="text-[13.5px] leading-[1.45] text-ink-dim">
            {effectLine(verdict, decision.tasks)}
          </p>
        )}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-2 md:grid-cols-[auto_minmax(0,1fr)_auto]">
          <BackButton disabled={first || writing} onClick={onBack} />
          {!gone && !custom && (
            <GrowingTextarea
              aria-label="Add a note for the agent (optional)"
              placeholder="Add a note for the agent (optional)"
              value={selection.note}
              disabled={writing}
              onChange={(event) => onChange({ note: event.target.value })}
              className="max-md:order-first max-md:col-span-2"
            />
          )}
          <PrimaryButton
            aria-label={`${label} (${decision.id})`}
            disabled={blocked}
            onClick={(event) => onNext(event.currentTarget)}
          >
            {label}
          </PrimaryButton>
        </div>
      </Composer>
    </section>
  );
}
