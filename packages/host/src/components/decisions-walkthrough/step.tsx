import { ago } from '../../lib/time';
import {
  WalkthroughBack,
  WalkthroughBar,
  WalkthroughBody,
  WalkthroughChoices,
  WalkthroughCommit,
  WalkthroughHeading,
  WalkthroughNext,
  WalkthroughNote,
  WalkthroughRow,
  useWalkthroughBusy,
} from '../patterns/walkthrough';
import { SENDING, effectLine, stepButtonLabel } from './copy';
import type { StepTarget } from './copy';
import { AgentGlyph } from './icons';
import { isBlankCustom, optionDetail, verdictOf } from './model';
import type { Selection, WalkDecision } from './model';
import { MetaLine } from './parts';

/**
 * The flags beside an option: "Agent's answer" in attention violet, "Agent
 * recommends" in dim ink. Each flag's visible text is hidden from the
 * accessibility tree and a hidden ", <flag>" stands in for it, so the
 * option's accessible name reads "Remove, Agent recommends" rather than
 * running the option's text into the flag.
 */
function Flag({ text, className }: { text: string; className: string }) {
  return (
    <>
      <span aria-hidden="true" className={`text-xs font-semibold ${className}`}>
        {text}
      </span>
      <span className="sr-only">, {text}</span>
    </>
  );
}

function Flags({ decision, number }: { decision: WalkDecision; number: number }) {
  return (
    <>
      {number === decision.taken && (
        <Flag text="Agent's answer" className="text-attention-foreground" />
      )}
      {number === decision.recommended && decision.recommended !== decision.taken && (
        <Flag text="Agent recommends" className="text-ink-dim" />
      )}
    </>
  );
}

/** The choice that holds an answer of the operator's own, after the options. */
const CUSTOM = 'custom';

/**
 * The answers, on the Walkthrough's Radio: one row per option, flagged where
 * the agent took or recommends it, then a last row for the operator's own
 * words, whose text box shows under the group.
 */
function Answers({
  decision,
  selection,
  onChange,
}: {
  decision: WalkDecision;
  selection: Selection;
  onChange: (patch: Partial<Selection>) => void;
}) {
  const choices = [
    ...decision.options.map((text, index) => {
      const number = index + 1;
      return {
        detail: optionDetail(decision, number),
        label: (
          <>
            <span>{text}</span>
            <Flags decision={decision} number={number} />
          </>
        ),
        value: String(number),
      };
    }),
    { label: <span className="text-ink-dim">Something else</span>, value: CUSTOM },
  ];
  return (
    <>
      <WalkthroughChoices
        label={`Your answer to ${decision.id}`}
        choices={choices}
        value={selection.choice === 'custom' ? CUSTOM : String(selection.choice)}
        onChange={(value) => onChange({ choice: value === CUSTOM ? 'custom' : Number(value) })}
      />
      {selection.choice === 'custom' && (
        <div className="pt-3">
          <WalkthroughNote
            label="Your own answer"
            placeholder="The answer you want"
            value={selection.answer}
            onChange={(answer) => onChange({ answer })}
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
    <div className="mt-6">
      <p className="mb-1 text-meta font-semibold text-ink-dim">Built on this answer</p>
      <ul className="flex flex-col">
        {tasks.map((id) => (
          <li key={id} className="flex items-baseline gap-2 py-1 text-body">
            <span className="font-mono text-ink-dim">{id}</span>
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
  target,
  first,
  offline,
  onChange,
  onBack,
  onNext,
}: {
  decision: WalkDecision;
  gone: boolean;
  selection: Selection;
  titles: ReadonlyMap<string, string>;
  target: StepTarget;
  first: boolean;
  offline: boolean;
  onChange: (patch: Partial<Selection>) => void;
  onBack: () => void;
  /** Move on, or, for a lone decision (`target` send), write: a write returns its promise, which holds the layer. */
  onNext: () => void | Promise<void>;
}) {
  const taken = decision.options[decision.taken - 1] ?? '';
  const recommended = decision.options[decision.recommended - 1];
  const verdict = verdictOf(decision, selection);
  const custom = selection.choice === 'custom';
  const commits = target === 'send';
  const blocked = gone ? commits : isBlankCustom(selection) || (commits && offline);
  const label = gone ? goneLabel(target) : stepButtonLabel(verdict, target);
  const busy = useWalkthroughBusy();
  return (
    <section aria-label={`Decision ${decision.id}`} className="flex min-h-0 flex-1 flex-col">
      <WalkthroughBody>
        <MetaLine>
          <span className="flex items-center gap-1.5 font-semibold text-attention-foreground">
            <AgentGlyph />
            Agent
          </span>
          <span className="capitalize">{decision.class}</span>
          <span>{ago(decision.created_at)}</span>
          <span className="font-mono">{decision.id}</span>
        </MetaLine>
        <WalkthroughHeading className="mb-3">{decision.question}</WalkthroughHeading>
        <p className="mb-2 text-body text-ink">
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
          <p className="mb-5 max-w-[62ch] text-body text-ink-dim">{decision.why}</p>
        )}
        {gone ? (
          <p
            role="status"
            className="mt-3 rounded-lg border border-line bg-well-850 p-3 text-body text-ink-dim"
          >
            This decision no longer waits on you
          </p>
        ) : (
          <Answers decision={decision} selection={selection} onChange={onChange} />
        )}
        <BuiltOn tasks={decision.tasks} titles={titles} />
      </WalkthroughBody>
      <WalkthroughBar>
        {!gone && <p className="text-meta text-ink-dim">{effectLine(verdict, decision.tasks)}</p>}
        <WalkthroughRow>
          <WalkthroughBack disabled={first} onClick={onBack} />
          {!gone && !custom && (
            <WalkthroughNote
              label="Add a note for the agent (optional)"
              placeholder="Add a note for the agent (optional)"
              value={selection.note}
              onChange={(note) => onChange({ note })}
              className="max-md:order-first max-md:col-span-2"
            />
          )}
          {commits ? (
            <WalkthroughCommit
              // While it writes, the button is named by its pending label alone.
              aria-label={busy ? undefined : `${label} (${decision.id})`}
              disabled={blocked}
              onCommit={onNext}
              pendingLabel={SENDING}
            >
              {label}
            </WalkthroughCommit>
          ) : (
            <WalkthroughNext
              aria-label={`${label} (${decision.id})`}
              disabled={blocked}
              onClick={() => void onNext()}
            >
              {label}
            </WalkthroughNext>
          )}
        </WalkthroughRow>
      </WalkthroughBar>
    </section>
  );
}
