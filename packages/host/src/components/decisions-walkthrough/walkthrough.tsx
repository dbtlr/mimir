import { Dialog } from '@base-ui-components/react/dialog';
import { useEffect, useRef, useState } from 'react';

import { useAnswerDecisions } from '../../api/delivery-mutations';
import type { Connectivity } from '../../lib/connectivity';
import { readDraft, pruneDrafts, removeDraft, writeDraft } from '../../lib/decision-drafts';
import { OfflineBanner } from '../offline-banner';
import { CheckStep } from './check-step';
import type { StepTarget } from './copy';
import { DoneScreen } from './done-screen';
import type { SendResult } from './done-screen';
import { CloseGlyph } from './icons';
import {
  answerFor,
  initialSelection,
  isBlankCustom,
  scopeDelivery,
  scopeSet,
  walkSet,
} from './model';
import type { Selection, WalkDecision, WalkScope } from './model';
import { PageLink } from './page-link';
import { Scroll, ScreenHeading } from './parts';
import { Rail, SegmentedBar } from './rail';
import { Step } from './step';

/** What a walkthrough reads: the live provisional decisions, whether that read has settled, and the tasks' titles. */
export type WalkRead = {
  /** The live read's decisions; undefined until a read lands. */
  decisions: readonly WalkDecision[] | undefined;
  /** The read is fresh, or cannot be refreshed (failed, or paused offline), so the set may be fixed on it. */
  settled: boolean;
  /** No read has landed and the last one failed. */
  failed: boolean;
  titles: ReadonlyMap<string, string>;
  conn: Connectivity;
};

/** Which screen shows, so focus moves to its heading when it changes. */
function screenOf(state: {
  results: boolean;
  fixed: boolean;
  count: number;
  onCheck: boolean;
  place: number;
}): string {
  if (state.results) {
    return 'done';
  }
  if (!state.fixed) {
    return 'loading';
  }
  if (state.count === 0) {
    return 'empty';
  }
  return state.onCheck ? 'check' : `step-${String(state.place)}`;
}

/** The header's progress: "N of M" on a step, "Check and send" on the check step, none elsewhere. */
function progressOf(state: {
  shown: boolean;
  count: number;
  onCheck: boolean;
  place: number;
}): string | null {
  if (!state.shown || state.count === 0) {
    return null;
  }
  return state.onCheck ? 'Check and send' : `${String(state.place + 1)} of ${String(state.count)}`;
}

/** What the step's button does: write straight away (a lone decision), go to the check step, or go on. */
function stepTarget(hasCheck: boolean, last: boolean): StepTarget {
  if (!hasCheck) {
    return 'send';
  }
  return last ? 'review' : 'continue';
}

/** Where the operator is: a decision's step, or one past the last, the check step. */
type Place = number;

/**
 * The decisions walkthrough (ADR 0019, MMR-703 refinement): a layer over the
 * whole console that takes the operator through a fixed set of provisional
 * decisions, one per screen, then sends every answer together. It owns the
 * steps' place, the selections, and the one write; `onClose` leaves the mode.
 */
export function DecisionsWalkthrough({
  scope,
  read,
  onClose,
}: {
  scope: WalkScope;
  read: WalkRead;
  onClose: () => void;
}) {
  const [fixed, setFixed] = useState<readonly WalkDecision[] | null>(null);
  const [selections, setSelections] = useState<Readonly<Record<string, Selection>>>({});
  const [openIds, setOpenIds] = useState<readonly string[]>([]);
  const [step, setStep] = useState<Place>(0);
  const [answered, setAnswered] = useState<ReadonlySet<number>>(new Set());
  const [results, setResults] = useState<SendResult[] | null>(null);
  // The decisions a Send is writing. Its refetches land before its results, so they stay live until then.
  const [sending, setSending] = useState<ReadonlySet<string> | null>(null);
  // The control whose Send failed: it takes focus back once the write ends, if focus was lost with it.
  const [refusal, setRefusal] = useState<{ control: HTMLElement } | null>(null);
  const refocused = useRef(refusal);
  const send = useAnswerDecisions();
  // Set before `mutate`, since the controls only disable after TanStack re-renders.
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const set = scopeSet(scope);
  const writing = send.isPending;

  // The set is fixed once, from a settled read: a decision that joins later waits for the next opening.
  if (fixed === null && read.decisions !== undefined && read.settled) {
    const live = walkSet(read.decisions);
    setFixed(live);
    setOpenIds(read.decisions.filter((d) => d.lifecycle === 'provisional').map((d) => d.id));
    setSelections(
      Object.fromEntries(live.map((d) => [d.id, initialSelection(d, readDraft(d.id))])),
    );
  }
  useEffect(() => {
    if (fixed !== null) {
      pruneDrafts(set, openIds);
    }
    // Once, when the set is fixed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [fixed]);

  const live =
    sending ??
    new Set((read.decisions ?? []).filter((d) => d.lifecycle === 'provisional').map((d) => d.id));
  const decisions = fixed ?? [];
  const count = decisions.length;
  const hasCheck = count > 1;
  const place = hasCheck ? step : Math.min(step, Math.max(count - 1, 0));
  const onCheck = hasCheck && place === count;
  const screen = screenOf({
    count,
    fixed: fixed !== null,
    onCheck,
    place,
    results: results !== null,
  });
  useEffect(() => {
    headingRef.current?.focus();
  }, [screen]);
  useEffect(() => {
    if (refusal === refocused.current || writing) {
      return;
    }
    refocused.current = refusal;
    const active = document.activeElement;
    // Focus is lost when it fell back to the page or the layer; focus the operator moved stays put.
    if (refusal !== null && (active === null || active.contains(refusal.control))) {
      refusal.control.focus();
    }
  }, [refusal, writing]);

  const change = (id: string, patch: Partial<Selection>) => {
    const next = { ...selections[id]!, ...patch };
    setSelections((current) => ({ ...current, [id]: next }));
    writeDraft(id, { ...next, set });
  };
  // A blank "Something else" that still waits cannot be sent, so nothing leads to Send while one stands.
  const blank = decisions.some((d) => live.has(d.id) && isBlankCustom(selections[d.id]!));
  const sendAll = async (control: HTMLElement) => {
    const items = decisions.filter((d) => live.has(d.id));
    if (inFlight.current || items.length === 0 || blank) {
      return;
    }
    inFlight.current = true;
    setSending(live);
    try {
      const answer = await send.mutateAsync({
        answers: items.map((d) => answerFor(d, selections[d.id]!)),
        delivery: scopeDelivery(scope),
      });
      // A recorded answer's draft is spent; a refused or failed one keeps its draft.
      for (const result of answer.results) {
        if (result.outcome === 'confirmed' || result.outcome === 'overturned') {
          removeDraft(result.id);
        }
      }
      setResults(answer.results);
    } catch {
      // The write's own error toast has said why; the answers stay as they are.
      setRefusal({ control });
    } finally {
      inFlight.current = false;
      setSending(null);
    }
  };
  const next = (control: HTMLElement) => {
    setAnswered((current) => new Set(current).add(place));
    if (place < count - 1) {
      setStep(place + 1);
    } else if (hasCheck) {
      setStep(count);
    } else {
      void sendAll(control);
    }
  };

  const current = decisions[place];
  const progress = progressOf({ count, onCheck, place, shown: results === null && fixed !== null });
  const heading =
    scope.kind === 'delivery' ? (
      <>
        <span className="min-w-0 truncate">{scope.title}</span>{' '}
        <span className="font-mono text-mono-id font-normal text-ink-faint">{scope.id}</span>
      </>
    ) : (
      <>
        <span>Decisions without a delivery</span>{' '}
        <span className="font-mono text-mono-id font-normal text-ink-faint">{scope.key}</span>
      </>
    );

  let body;
  if (results !== null) {
    body = (
      <DoneScreen scope={scope} decisions={decisions} results={results} headingRef={headingRef} />
    );
  } else if (fixed === null) {
    body = (
      <Scroll>
        <ScreenHeading headingRef={headingRef} aria-busy={!read.failed}>
          {read.failed ? 'Couldn’t load the decisions' : 'Loading the decisions'}
        </ScreenHeading>
      </Scroll>
    );
  } else if (count === 0) {
    body = (
      <Scroll>
        <ScreenHeading headingRef={headingRef} className="mb-3">
          Nothing waits on you here
        </ScreenHeading>
        <PageLink
          scope={scope}
          className="rounded-sm font-semibold text-accent-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent max-md:inline-flex max-md:min-h-11 max-md:items-center"
        />
      </Scroll>
    );
  } else if (onCheck) {
    body = (
      <CheckStep
        entries={decisions.flatMap((decision, index) =>
          live.has(decision.id) ? [{ decision, index, selection: selections[decision.id]! }] : [],
        )}
        delivery={scopeDelivery(scope)}
        headingRef={headingRef}
        writing={writing}
        offline={read.conn.offline}
        onChange={setStep}
        onBack={() => setStep(count - 1)}
        onSend={(control) => void sendAll(control)}
      />
    );
  } else if (current !== undefined) {
    body = (
      <Step
        key={current.id}
        decision={current}
        gone={!live.has(current.id)}
        selection={selections[current.id]!}
        titles={read.titles}
        headingRef={headingRef}
        target={stepTarget(hasCheck, place === count - 1)}
        first={place === 0}
        writing={writing}
        offline={read.conn.offline}
        onChange={(patch) => change(current.id, patch)}
        onBack={() => setStep(place - 1)}
        onNext={next}
      />
    );
  }

  const showRail = fixed !== null && count > 0 && results === null;
  return (
    <Dialog.Root
      open
      modal
      onOpenChange={(open) => {
        if (!open && !writing) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup
          initialFocus={() => headingRef.current}
          className="fixed inset-0 z-50 flex flex-col bg-well-900 text-ink outline-none"
        >
          <OfflineBanner {...read.conn} />
          <header className="flex items-center gap-3 border-b border-line bg-well-950 px-4 py-3 md:px-6 md:py-3.5">
            <Dialog.Close
              aria-label="Close the walkthrough"
              disabled={writing}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-dim hover:bg-line/50 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 md:size-9"
            >
              <CloseGlyph />
            </Dialog.Close>
            <Dialog.Title className="flex min-w-0 flex-1 items-baseline gap-2.5 text-[15.5px] font-bold text-ink-bright">
              {heading}
            </Dialog.Title>
            {progress !== null && (
              <p className="text-meta font-semibold whitespace-nowrap text-attention-foreground">
                {progress}
              </p>
            )}
          </header>
          {showRail && <SegmentedBar count={hasCheck ? count + 1 : count} step={place} />}
          <div className="flex min-h-0 flex-1">
            {showRail && (
              <Rail
                entries={decisions.map((decision, index) => ({
                  answered: answered.has(index),
                  decision,
                  gone: !live.has(decision.id),
                  selection: selections[decision.id]!,
                }))}
                step={place}
                hasCheck={hasCheck}
                checkReady={!blank && decisions.every((_, index) => answered.has(index))}
                disabled={writing}
                onGo={setStep}
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col">{body}</div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
