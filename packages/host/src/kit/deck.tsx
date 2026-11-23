import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';

import { GroomingBadge } from '../components/grooming-chip';
import { AttentionLead } from '../components/needs-you-deck-view';
import { FeedDeck } from '../components/patterns/feed/deck';
import type { DeckCard, DeckWrite } from '../components/patterns/feed/deck';
import type { Preview } from '../components/patterns/feed/preview-panel';
import { StatusBadge } from '../components/status-badge';
import { ActionButton } from '../components/ui/action-button';
import { deliveryLink, nodeLink } from '../lib/record-url';
import { Section } from './section';

/*
 * The Needs you deck (ADR 0019, MMR-721 refinement) over sample cards of every
 * kind: a stopped delivery with Clear stop, a delivery's and a project's
 * decisions, a question with Answer…, and a task blocked on you. The controls
 * set the deck's size and play a refetch; the actions are stubs, and Clear
 * stop stays in flight until Land or Refuse settles it. No page mounts the
 * deck yet (Home, MMR-722).
 */

type Sample = { card: DeckCard; preview: Omit<Preview, 'action'> };

/** A sample card under a key, its own by default; the 120 cards' clones take a generated one. */
type MakeSample = (key?: string) => Sample;

/** A write the deck started on the card with `key`, until a control settles it. */
type Held = { key: string; write: DeckWrite };

function stopped(
  id: string,
  title: string,
  reason: string,
  age: string,
  hold: (held: Held) => void,
): MakeSample {
  return (key = id) => ({
    card: {
      action: {
        kind: 'write',
        label: 'Clear stop',
        name: `Clear stop on ${id}`,
        run: ({ write }) => {
          write.start();
          // Settles against the card's own key; a clone keeps its original's ID for display.
          hold({ key, write });
        },
      },
      card: { age, detail: reason, id, lead: <AttentionLead word="Stopped" />, title },
      key,
      previewKey: key,
    },
    preview: {
      age,
      facts: [{ label: 'Phase', value: 'Fleet 0.9: rolling upgrades' }],
      id,
      lead: <AttentionLead word="Stopped" />,
      open: deliveryLink(id),
      reason,
      title,
    },
  });
}

function bundle(
  set: string,
  title: string,
  decisions: number,
  tasks: number,
  age: string,
): MakeSample {
  const name = set.slice(set.indexOf(':') + 1);
  const detail = tasks === 0 ? 'No work is built on them yet.' : `Across ${String(tasks)} tasks.`;
  return (key = set) => ({
    card: {
      action: {
        kind: 'navigate',
        label: `Review ${String(decisions)} decisions`,
        name: `Review ${String(decisions)} decisions on ${name}`,
        run: ({ button }) => {
          button?.focus();
        },
      },
      card: { age, detail, id: name, lead: <AttentionLead word="Decisions" />, title },
      key,
      previewKey: key,
    },
    preview: {
      age,
      id: name,
      lead: <AttentionLead word="Decisions" />,
      open: nodeLink('MMR-706'),
      openId: name,
      reason: `This delivery has ${String(decisions)} provisional decisions.`,
      title,
    },
  });
}

function question(id: string, title: string, ask: string, age: string): MakeSample {
  return (key = id) => ({
    card: {
      action: {
        kind: 'dialog',
        label: 'Answer…',
        name: `Answer ${id}`,
        run: ({ button }) => {
          button?.focus();
        },
      },
      card: {
        age,
        chips: <GroomingBadge state="needs_answers" />,
        detail: ask,
        id,
        lead: <StatusBadge status="ready" />,
        title,
      },
      key,
      previewKey: key,
    },
    preview: {
      age,
      id,
      lead: <StatusBadge status="ready" />,
      open: nodeLink(id),
      reason: (
        <>
          <b>Needs an answer before it can start.</b> {ask}
        </>
      ),
      title,
    },
  });
}

function blocked(id: string, title: string, reason: string, age: string): MakeSample {
  return (key = id) => ({
    card: {
      card: { age, detail: reason, id, lead: <StatusBadge status="blocked" />, title },
      key,
      previewKey: key,
    },
    preview: {
      age,
      id,
      lead: <StatusBadge status="blocked" />,
      open: nodeLink(id),
      reason: (
        <>
          <b>Blocked on you.</b> {reason}
        </>
      ),
      title,
    },
  });
}

/** The ten sample cards, in the set's order. */
function samples(hold: (held: Held) => void): MakeSample[] {
  return [
    stopped(
      'FLT-d2',
      'Rolling host upgrades',
      'Stopped by its time cap after 4 hours. FLT-88’s drain step hung on asgard, waiting for a lease that never expired.',
      '25m',
      hold,
    ),
    stopped(
      'MMR-d9',
      'Offline outbox',
      'The agent stopped itself: the outbox migration needs to know whether queued writes older than 7 days are dropped or kept.',
      '2h',
      hold,
    ),
    bundle('delivery:LM-d3', 'Release channels', 12, 20, '40m'),
    bundle('delivery:FLT-d2', 'Rolling host upgrades', 3, 4, '1h'),
    question(
      'MMR-731',
      'Retry a failed push send',
      'Should a send that fails retry on the next wake, or wait for the operator?',
      '1h',
    ),
    blocked(
      'LM-602',
      'Notarize the macOS build',
      'Approve the notarization account before the release job can sign.',
      '3h',
    ),
    bundle('project:MMR', 'Mimir decisions without a delivery', 4, 0, '5h'),
    question(
      'NORN-560',
      'Let a release channel pin a minimum version, so a bad build can be held back without deleting its tag',
      'Where does the pin live, and who may set it?',
      '1d',
    ),
    blocked(
      'FLT-91',
      'Rotate the fleet’s TLS roots',
      'Confirm the new root before it ships.',
      '2d',
    ),
    question('HUGI-15', 'Keep run logs and make them readable', 'Where are logs read?', '3d'),
  ];
}

/** `count` cards cycled from the samples, each with its own identity. */
function sized(all: readonly MakeSample[], count: number): Sample[] {
  return Array.from({ length: count }, (_, index) => {
    const make = all[index % all.length];
    if (make === undefined || index < all.length) {
      return make?.();
    }
    return make(`${make().card.key}#${String(index)}`);
  }).filter((sample): sample is Sample => sample !== undefined);
}

function Control({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <ActionButton size="sm" variant="outline" onClick={onClick}>
      {children}
    </ActionButton>
  );
}

/** The deck and its controls, also the Chromium harness's page (e2e/feed-deck.test.ts). */
export function DeckDemo({ initial = 10 }: { initial?: number }) {
  // Every write in flight by its card's key: the deck lets several run at once.
  const [held, setHeld] = useState<ReadonlyMap<string, DeckWrite>>(() => new Map());
  const hold = ({ key, write }: Held) => {
    setHeld((current) => new Map(current).set(key, write));
  };
  const release = (key: string) => {
    setHeld((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  };
  const all = samples(hold);
  const [shown, setShown] = useState(() => sized(all, initial).map((sample) => sample.card.key));
  const [offline, setOffline] = useState(false);
  const byKey = new Map(sized(all, 120).map((sample) => [sample.card.key, sample]));
  const deck = shown.flatMap((key) => byKey.get(key) ?? []);
  const show = (count: number) => {
    setShown(sized(all, count).map((sample) => sample.card.key));
  };

  return (
    <div className="flex flex-col gap-3" data-kit="deck">
      <div className="flex flex-wrap gap-2">
        <Control onClick={() => show(10)}>10 cards</Control>
        <Control onClick={() => show(4)}>4 cards</Control>
        <Control onClick={() => show(1)}>1 card</Control>
        <Control onClick={() => show(0)}>0 cards</Control>
        <Control onClick={() => show(120)}>120 cards</Control>
        <Control onClick={() => setShown((keys) => keys.filter((_, index) => index !== 1))}>
          Card 2 leaves
        </Control>
        <Control onClick={() => setShown((keys) => keys.toReversed())}>Refetch reversed</Control>
        <Control onClick={() => setOffline((value) => !value)}>
          {offline ? 'Go online' : 'Go offline'}
        </Control>
        {[...held].map(([key, write]) => (
          <Fragment key={key}>
            <Control
              onClick={() => {
                write.landed();
                setShown((keys) => keys.filter((shownKey) => shownKey !== key));
                release(key);
              }}
            >
              Land {key}’s write
            </Control>
            <Control
              onClick={() => {
                write.refused();
                release(key);
              }}
            >
              Refuse {key}’s write
            </Control>
          </Fragment>
        ))}
      </div>
      <FeedDeck
        title="Needs you"
        seeAll={{ to: '/' }}
        cards={deck.map((sample) => sample.card)}
        preview={(key) => byKey.get(key)?.preview}
        quiet="Nothing needs you."
        offline={offline}
      />
    </div>
  );
}

export function DeckKit() {
  return (
    <Section title="Needs you deck">
      <p className="m-0 text-meta text-ink-dim">
        Swipe, tap the peek, or use the arrows and Left and Right. Clear stop stays in flight until
        Land or Refuse settles it.
      </p>
      <div className="max-w-[900px]">
        <DeckDemo />
      </div>
    </Section>
  );
}
