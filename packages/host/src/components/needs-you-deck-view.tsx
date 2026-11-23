import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

import type { ReviewReport } from '../api/view-queries';
import { deliveryLink, nodeLink } from '../lib/record-url';
import { relativeTime } from '../lib/time';
import { markState, useOpenerPath, useReturnTargetResolver } from '../lib/walkthrough-mark';
import { entryName } from './decisions-entry';
import { needsYouCards } from './needs-you-deck-model';
import type {
  NeedsYouCard,
  NeedsYouFact,
  NeedsYouLead,
  NeedsYouOpen,
} from './needs-you-deck-model';
import { FeedDeck } from './patterns/feed/deck';
import type { DeckAction, DeckCard, DeckWrite, FeedDeckHandle } from './patterns/feed/deck';
import type { FeedLink } from './patterns/feed/link';
import { PreviewRelation } from './patterns/feed/preview-panel';
import type { Preview } from './patterns/feed/preview-panel';
import { StatusBadge, StatusWord } from './status-badge';

/*
 * The Needs you deck over the review report (ADR 0019, MMR-721 refinement):
 * the cards `needsYouCards` maps, their leads, previews, and actions, and the
 * walkthrough's return. Its two writes come in through `writes`, so /kit and
 * the Chromium harness run it without the console's server functions;
 * `NeedsYouDeck` (needs-you-deck.tsx) passes the console's own.
 */

/** The deck's writes: Clear stop, and the answer dialog. */
export type NeedsYouWrites = {
  /**
   * Clears a delivery's stop and wakes its thread. Resolves once the write
   * and its refetch have landed; rejects when it is refused, its toast shown.
   */
  clearStop: (delivery: string) => Promise<unknown>;
  /** The answer dialog for a task, mounted only while open; it calls `onClose` once it is done. */
  AnswerDialog: ComponentType<{
    nodeId: string;
    question: string | null;
    offline: boolean;
    onClose: () => void;
  }>;
};

/** An attention dot and a word: the lead of a stopped delivery, a set of decisions, or a question. */
export function AttentionLead({ word }: { word: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="inline-block size-[7px] shrink-0 rounded-full bg-attention" />
      <StatusWord>{word}</StatusWord>
    </span>
  );
}

function leadOf(lead: NeedsYouLead): ReactNode {
  return lead.kind === 'attention' ? (
    <AttentionLead word={lead.word} />
  ) : (
    <StatusBadge status={lead.status} />
  );
}

function openLink(open: NeedsYouOpen): FeedLink {
  switch (open.kind) {
    case 'delivery': {
      return deliveryLink(open.id);
    }
    case 'project': {
      return { params: { key: open.key }, to: '/p/$key' };
    }
    case 'task': {
      return nodeLink(open.id);
    }
    default: {
      const unexpected: never = open;
      return unexpected;
    }
  }
}

function factValue(fact: NeedsYouFact): ReactNode {
  if ('text' in fact) {
    return fact.text;
  }
  return fact.ids.map((id) => <PreviewRelation key={id} id={id} />);
}

function previewOf(card: NeedsYouCard): Omit<Preview, 'action'> {
  const { reason, text, facts, open } = card.preview;
  return {
    age: relativeTime(card.at),
    facts: facts.map((fact) => ({ label: fact.label, value: factValue(fact) })),
    id: card.id,
    lead: leadOf(card.lead),
    open: openLink(open),
    project: card.project,
    reason:
      reason.strong === undefined ? (
        reason.text
      ) : (
        <>
          <b>{reason.strong}</b>
          {reason.text === undefined ? null : ` ${reason.text}`}
        </>
      ),
    text,
    title: card.title,
  };
}

/** Reports a write's progress to the deck: in flight until it lands or is refused. */
async function settle(work: Promise<unknown>, write: DeckWrite): Promise<void> {
  write.start();
  try {
    await work;
  } catch {
    write.refused();
    return;
  }
  write.landed();
}

/** The answer dialog that is open, for which card. */
type Answering = { key: string; task: string; question: string | null };

export function NeedsYouDeckView({
  report,
  writes,
  offline = false,
  seeAll,
  countItems = false,
  className,
}: {
  report: ReviewReport;
  writes: NeedsYouWrites;
  offline?: boolean;
  seeAll?: FeedLink;
  /** The head counts the set's records beside the cards, as the top-bar alert counts them (Home, MMR-722). */
  countItems?: boolean;
  className?: string;
}) {
  const cards = useMemo(() => needsYouCards(report), [report]);
  const deck = useRef<FeedDeckHandle>(null);
  const navigate = useNavigate();
  const opener = useOpenerPath();
  const [answering, setAnswering] = useState<Answering | null>(null);
  // The card whose answer dialog just closed: focus is resolved once the dialog has gone.
  const closed = useRef<string | null>(null);

  // A walkthrough's return asks the deck for a bundle before it queries the page. The shell
  // asks while React is still committing the page, so the turn, which renders at once, waits a
  // microtask, and answers with whether the deck held the card.
  const bundles = useMemo(
    () => new Set(cards.filter((card) => card.action?.kind === 'review').map((card) => card.key)),
    [cards],
  );
  const turnAfterCommit = async (entry: string): Promise<boolean> => {
    await Promise.resolve();
    return deck.current?.turnTo(entry) ?? false;
  };
  useReturnTargetResolver((entry) => (bundles.has(entry) ? turnAfterCommit(entry) : false));

  // The effect can run inside React's commit, where the deck's turn could not render at once.
  useEffect(() => {
    const key = closed.current;
    if (key !== null && answering === null) {
      closed.current = null;
      queueMicrotask(() => {
        deck.current?.restoreFocus(key);
      });
    }
  }, [answering]);

  const actionOf = (card: NeedsYouCard): DeckAction | undefined => {
    const { action } = card;
    switch (action?.kind) {
      case undefined: {
        return undefined;
      }
      case 'review': {
        const { set } = action;
        const state = markState({ entry: entryName(set), opener });
        return {
          kind: 'navigate',
          label: action.label,
          name: action.name,
          run: () => {
            void (set.kind === 'delivery'
              ? navigate({ ...deliveryLink(set.id), search: { mode: 'decisions' }, state })
              : navigate({
                  params: { key: set.key },
                  search: { mode: 'decisions' },
                  state,
                  to: '/p/$key',
                }));
          },
        };
      }
      case 'clear-stop': {
        return {
          kind: 'write',
          label: action.label,
          name: action.name,
          run: ({ write }) => {
            void settle(writes.clearStop(action.delivery), write);
          },
        };
      }
      case 'answer': {
        return {
          kind: 'dialog',
          label: action.label,
          name: action.name,
          run: () => {
            setAnswering({ key: card.key, question: action.question, task: action.task });
          },
        };
      }
      default: {
        const unexpected: never = action;
        return unexpected;
      }
    }
  };

  const deckCards: DeckCard[] = cards.map((card) => ({
    action: actionOf(card),
    card: {
      age: relativeTime(card.at),
      detail: card.detail,
      id: card.id,
      lead: leadOf(card.lead),
      project: card.project,
      title: card.title,
    },
    key: card.key,
    previewKey: card.key,
  }));
  const previews = new Map(cards.map((card) => [card.key, card]));
  // The question updates in place while the dialog is open, as an answer that keeps the task at needs answers does.
  const asked = cards.find((card) => card.key === answering?.key)?.action;
  const question = asked?.kind === 'answer' ? asked.question : (answering?.question ?? null);

  return (
    <>
      <FeedDeck
        ref={deck}
        title="Needs you"
        seeAll={seeAll}
        cards={deckCards}
        items={countItems ? report.queue.length : undefined}
        preview={(key) => {
          const card = previews.get(key);
          return card === undefined ? undefined : previewOf(card);
        }}
        quiet="Nothing needs you."
        offline={offline}
        className={className}
      />
      {answering !== null && (
        <writes.AnswerDialog
          nodeId={answering.task}
          question={question}
          offline={offline}
          onClose={() => {
            closed.current = answering.key;
            setAnswering(null);
          }}
        />
      )}
    </>
  );
}
