import { useMemo, useState } from 'react';

import { browserTimeZone } from '../api/queries';
import { foldByDay } from '../lib/day-folds';
import { describeTransition, sessionRoles } from '../lib/timeline';
import type { FeedItem, HistoryEntry } from '../lib/timeline';
import { shippedTime } from '../lib/work-page';
import { AnnotationComposer } from './annotation-composer';
import { LinkifiedText } from './linkified-text';
import { MarkdownBody } from './markdown-body';
import type { ClampMeasure } from './markdown-body';
import { MetaPart } from './meta-part';
import { DayFolds } from './patterns/feed/day-fold';
import { ShowMoreButton } from './patterns/feed/show-more';
import { ThreadDot, ThreadEvent, ThreadNote } from './patterns/feed/thread';
import { Skeleton } from './ui/skeleton';

/*
 * A record's timeline (ADR 0019, MMR-728 refinement): the one timeline of a
 * task's, an initiative's, and a phase's page. The composer leads; the
 * record's creation, transitions, and notes follow, newest first, folded by
 * the day they happened with only the latest day open, each hung on the
 * thread: an event as one line, a note as a card.
 */

/** Filled dot color per transition destination; unmapped destinations stay neutral. */
const TRANSITION_DOT: Record<string, string> = {
  abandoned: 'bg-status-abandoned',
  blocked: 'bg-status-blocked',
  done: 'bg-status-done',
  in_progress: 'bg-status-in-progress',
  parked: 'bg-status-parked',
  queued: 'bg-status-queued',
  staged: 'bg-status-staged',
  under_review: 'bg-status-under-review',
};

/** A note longer than this many lines folds under Show all. */
const NOTE_CLAMP = 12;

function TransitionLine({ entry }: { entry: HistoryEntry }) {
  const { label, detail } = describeTransition(entry);
  const roles =
    entry.kind === 'assignment' || entry.handles === undefined ? [] : sessionRoles(entry.handles);
  return (
    <p>
      <span className="font-medium text-ink-bright">{label}</span>
      {detail != null && <span className="font-mono text-meta text-ink-dim"> {detail}</span>}
      {roles.length > 0 && (
        // A real space, not a margin, so the label and the handles read apart (MMR-718).
        <span className="text-ink-dim">
          {' '}
          {roles.map((role, index) => (
            <MetaPart key={role} mono first={index === 0}>
              {role}
            </MetaPart>
          ))}
        </span>
      )}
      {entry.reason != null && (
        <span className="text-ink-dim">
          {' — '}
          <LinkifiedText>{entry.reason}</LinkifiedText>
        </span>
      )}
    </p>
  );
}

/** Whether `target`, inside the clamped `article`, ends below the clamp, where the note hides it. */
function belowClamp(target: Element, article: HTMLElement): boolean {
  const offset =
    target.getBoundingClientRect().bottom - article.getBoundingClientRect().top + article.scrollTop;
  return offset > article.clientHeight;
}

/**
 * A note's body, clamped to 12 whole lines with the last one faded. "Show all
 * N lines" appears only when the rendered note really overflows its clamp; N
 * is the rendered line count the clamp measured. Focus that reaches a link
 * below the clamp opens the note, so a folded note never scrolls to it unseen.
 */
function NoteBody({ content, time }: { content: string; time: string }) {
  const [expanded, setExpanded] = useState(false);
  const [measure, setMeasure] = useState<ClampMeasure>({ lines: 0, overflowing: false });
  const more =
    measure.lines > 0
      ? `Show all ${String(measure.lines)} ${measure.lines === 1 ? 'line' : 'lines'}`
      : 'Show all';
  return (
    <ThreadNote
      time={time}
      footer={
        measure.overflowing && (
          // Flush with the note's text, and pulled back below so the 44 (36 from md) target adds no height to the card.
          <ShowMoreButton
            className="ml-0 -mb-3 md:-mb-2"
            onClick={() => {
              setExpanded((open) => !open);
            }}
          >
            {expanded ? 'Show less' : more}
          </ShowMoreButton>
        )
      }
    >
      <div
        onFocus={(event) => {
          const article = event.target.closest('article');
          if (
            !expanded &&
            measure.overflowing &&
            article !== null &&
            belowClamp(event.target, article)
          ) {
            setExpanded(true);
          }
        }}
      >
        <MarkdownBody
          breaks
          size="body"
          clamp={expanded ? undefined : NOTE_CLAMP}
          onClampMeasure={setMeasure}
          className="max-w-[70ch]"
        >
          {content}
        </MarkdownBody>
      </div>
    </ThreadNote>
  );
}

/** One entry of the timeline on its thread. */
function TimelineRow({ item, zone }: { item: FeedItem; zone: string }) {
  const time = shippedTime(item.at, zone);
  switch (item.variant) {
    case 'annotation': {
      return <NoteBody content={item.content} time={time} />;
    }
    case 'transition': {
      return (
        <ThreadEvent
          dot={<ThreadDot className={TRANSITION_DOT[item.entry.to ?? ''] ?? 'bg-ink-dim'} />}
          time={time}
        >
          <TransitionLine entry={item.entry} />
        </ThreadEvent>
      );
    }
    case 'created': {
      return (
        <ThreadEvent dot={<ThreadDot className="bg-ink-dim" />} time={time}>
          <span className="font-medium text-ink-bright">Created</span>
        </ThreadEvent>
      );
    }
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

/** What tells an entry apart from the others, whatever arrives before it. */
function entryIdentity(item: FeedItem): string {
  switch (item.variant) {
    case 'created': {
      return 'created';
    }
    case 'transition': {
      return `transition-${String(item.sort)}-${item.entry.kind}-${item.entry.to ?? ''}`;
    }
    case 'annotation': {
      return `annotation-${String(item.sort)}-${item.content}`;
    }
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

/** Each entry with a key from its identity, so its row keeps its state when an older entry arrives. */
function keyEntries(items: readonly FeedItem[]): { item: FeedItem; key: string }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const identity = entryIdentity(item);
    const repeats = seen.get(identity) ?? 0;
    seen.set(identity, repeats + 1);
    return { item, key: repeats === 0 ? identity : `${identity}-${String(repeats)}` };
  });
}

/** An entry's row, keyed for its day's fold. */
function timelineRow(item: FeedItem, key: string, zone: string) {
  return <TimelineRow key={key} item={item} zone={zone} />;
}

/**
 * A record's timeline: the composer, then `items` folded by day, newest
 * first. While the notes' first read is pending, a skeleton stands above the
 * entries already known (the creation and the transitions).
 */
export function RecordTimeline({
  items,
  pending,
  nodeId,
  offline,
}: {
  /** The record's entries, oldest first, as `buildFeed` merges them. */
  items: readonly FeedItem[];
  pending: boolean;
  nodeId: string;
  offline: boolean;
}) {
  const zone = browserTimeZone();
  const days = useMemo(
    () =>
      foldByDay(keyEntries(items).toReversed(), {
        at: ({ item }) => item.at,
        row: ({ item, key }) => timelineRow(item, key, zone),
        zone,
      }),
    [items, zone],
  );
  return (
    <div className="flex flex-col">
      <div className="pb-6">
        <AnnotationComposer nodeId={nodeId} offline={offline} />
      </div>
      {pending && <Skeleton className="mb-3 h-12 w-full" />}
      <DayFolds days={days} cap={Number.POSITIVE_INFINITY} thread />
    </div>
  );
}
