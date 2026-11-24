import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

import { deliveryLink, nodeLink } from '../lib/record-url';
import { relativeTime } from '../lib/time';
import { markState, useOpenerPath } from '../lib/walkthrough-mark';
import { entryName } from './decisions-entry';
import type {
  NeedsYouCard,
  NeedsYouFact,
  NeedsYouLead,
  NeedsYouOpen,
} from './needs-you-deck-model';
import type { CardAction, CardWrite } from './patterns/feed/card-actions';
import type { DeckCardContent } from './patterns/feed/deck';
import type { FeedLink } from './patterns/feed/link';
import { PreviewRelation } from './patterns/feed/preview-panel';
import type { Preview } from './patterns/feed/preview-panel';
import { StatusBadge, StatusWord } from './status-badge';

/*
 * The needs-you cards as the console draws and acts on them (ADR 0019,
 * MMR-721 and MMR-723 refinements): their leads, content, previews, and
 * actions, for both surfaces that show them, the Needs you deck and the Needs
 * you page. A walkthrough's navigation carries its mark, Clear stop reports
 * its write, and the answer dialog's state and mounting live here; where
 * focus goes once the dialog closes is the surface's own (`restoreFocus`).
 */

/** The cards' writes: Clear stop, and the answer dialog. */
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

/** A card's feed-card content: its lead, ID, project, age, title, and detail. */
export function needsYouContent(card: NeedsYouCard): DeckCardContent {
  return {
    age: relativeTime(card.at),
    detail: card.detail,
    id: card.id,
    lead: leadOf(card.lead),
    project: card.project,
    title: card.title,
  };
}

/** A card's preview, less the action the surface's card-action hook adds. */
export function needsYouPreview(card: NeedsYouCard): Omit<Preview, 'action'> {
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

/** Reports a write's progress to the surface: in flight until it lands or is refused. */
async function settle(work: Promise<unknown>, write: CardWrite): Promise<void> {
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

/**
 * The cards' actions and the answer dialog they open. `restoreFocus` is the
 * surface's return for a card once its dialog has closed. `namedReturns` puts
 * the MMR-714 return-target attribute on each bundle's button, for a surface
 * that registers no resolver with the opener-focus request (the page's list):
 * a walkthrough's return then finds the button in the document.
 */
export function useNeedsYouActions({
  cards,
  writes,
  offline,
  restoreFocus,
  namedReturns = false,
}: {
  cards: readonly NeedsYouCard[];
  writes: NeedsYouWrites;
  offline: boolean;
  restoreFocus: (key: string) => void;
  namedReturns?: boolean;
}): { actionOf: (card: NeedsYouCard) => CardAction | undefined; answerDialog: ReactNode } {
  const navigate = useNavigate();
  const opener = useOpenerPath();
  const [answering, setAnswering] = useState<Answering | null>(null);
  // The card whose answer dialog just closed: focus is resolved once the dialog has gone.
  const closed = useRef<string | null>(null);
  const restore = useRef(restoreFocus);
  useEffect(() => {
    restore.current = restoreFocus;
  });

  // The effect can run inside React's commit, where the surface could not render at once.
  useEffect(() => {
    const key = closed.current;
    if (key !== null && answering === null) {
      closed.current = null;
      queueMicrotask(() => {
        restore.current(key);
      });
    }
  }, [answering]);

  const actionOf = (card: NeedsYouCard): CardAction | undefined => {
    const { action } = card;
    switch (action?.kind) {
      case undefined: {
        return undefined;
      }
      case 'review': {
        const { set } = action;
        const entry = entryName(set);
        const state = markState({ entry, opener });
        return {
          kind: 'navigate',
          label: action.label,
          name: action.name,
          ...(namedReturns ? { returnTarget: entry } : {}),
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

  // The question updates in place while the dialog is open, as an answer that keeps the task at needs answers does.
  const asked = cards.find((card) => card.key === answering?.key)?.action;
  const question = asked?.kind === 'answer' ? asked.question : (answering?.question ?? null);
  const answerDialog =
    answering === null ? null : (
      <writes.AnswerDialog
        nodeId={answering.task}
        question={question}
        offline={offline}
        onClose={() => {
          closed.current = answering.key;
          setAnswering(null);
        }}
      />
    );

  return { actionOf, answerDialog };
}
