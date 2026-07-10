import { Dialog } from '@base-ui-components/react/dialog';
import type { NodeRef } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useTransition, useUpdateNode } from '../api/mutations';
import { annotationsQuery, nodeQuery } from '../api/queries';
import type { WireAnnotation, WireHistoryEntry, WireNode } from '../api/types';
import { cn } from '../lib/cn';
import type { TaskFormValues } from '../lib/schemas';
import { absoluteTime, ago } from '../lib/time';
import { availableTransitions } from '../lib/transitions';
import type { VerbSpec } from '../lib/transitions';
import { AnnotationComposer } from './annotation-composer';
import { MoveDialog } from './move-dialog';
import { ReasonDialog } from './reason-dialog';
import { OpenEndedBadge, PriorityBadge, SizeBadge, StaleBadge } from './signal-badges';
import { StatusBadge } from './status-badge';
import { TaskForm } from './task-form';
import type { TaskFormSubmit } from './task-form';
import { ActionButton } from './ui/action-button';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

function fromNode(n: WireNode): TaskFormValues {
  return {
    description: n.description ?? '',
    external_ref: n.external_ref ?? '',
    priority: n.priority ?? '',
    size: n.size ?? '',
    summary: n.summary ?? '',
    // Reparenting is the Move… verb (its own dialog), not the dumb update — the
    // edit form no longer carries a parent picker. Tags render read-only in
    // SIGNALS (5a), so the form omits them too.
    tags: [],
    title: n.title,
  };
}

/**
 * The node-detail **dossier** (Meridian 5a) — a centered overlay over a dimmed
 * board, URL-addressable (`?node=KEY-seq`). Two columns share one header: the
 * left is the stable record (title, verdict, description, signals, blocking,
 * artifacts); the right is the timeline ground (tabbed feed + append-only
 * composer). Replaces the retired right-anchored `NodeDrawer` at every mount.
 * The kebab is gone — legal transitions surface as labeled verb chips.
 */
export function NodeDossier({
  nodeId,
  onClose,
  onOpenNode,
  offline,
}: {
  nodeId: string | undefined;
  onClose: () => void;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  return (
    <Dialog.Root
      open={nodeId !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      {nodeId !== undefined && (
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-well-950/70 backdrop-blur-[2px] transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup
            aria-describedby={undefined}
            className="fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[min(92vw,900px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-bright bg-well-850 shadow-2xl outline-none transition-all duration-[180ms] ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 light:shadow-overlay"
          >
            <DossierBody key={nodeId} nodeId={nodeId} onOpenNode={onOpenNode} offline={offline} />
          </Dialog.Popup>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}

/** A labeled verb pill — the kebab's replacement (hairline ring, ink-dim). */
function VerbChip({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center rounded-full px-2.5 py-1 text-tag font-medium whitespace-nowrap text-ink-dim inset-ring inset-ring-line transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Microlabel({ children }: { children: ReactNode }) {
  return <h3 className="microlabel text-ink-faint">{children}</h3>;
}

function RefRow({ refNode, onOpenNode }: { refNode: NodeRef; onOpenNode: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpenNode(refNode.id)}
      className="flex items-center gap-2 rounded-sm px-1 py-0.5 text-left text-xs text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="font-mono text-mono-id text-accent-foreground">{refNode.id}</span>
      {refNode.title !== undefined && (
        <span className="truncate text-ink-dim">{refNode.title}</span>
      )}
    </button>
  );
}

/** external_ref is free text (e.g. `GH-123`, `PR #41`) — only link genuine URLs. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** external_ref as a `↗` link when it's a URL, else plain mono text (no dead link). */
function ExternalRef({ value }: { value: string }) {
  if (isHttpUrl(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="self-start font-mono text-mono-id text-accent-foreground hover:text-accent"
      >
        {value} ↗
      </a>
    );
  }
  return <span className="font-mono text-mono-id text-ink-dim">{value}</span>;
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-tag">
      <dt className="text-ink-dim">{label}</dt>
      <dd className="text-right font-mono text-ink">{children}</dd>
    </div>
  );
}

/** One merged feed entry — the node's birth, a transition, or an annotation. */
type FeedItem =
  | { variant: 'created'; at: string; sort: number }
  | { variant: 'transition'; at: string; sort: number; entry: WireHistoryEntry }
  | { variant: 'annotation'; at: string; sort: number; content: string };

/** Merge transitions + annotations + the creation anchor into one oldest-first feed. */
function buildFeed(
  createdAt: string,
  history: readonly WireHistoryEntry[] | undefined,
  annotations: readonly WireAnnotation[] | undefined,
): FeedItem[] {
  const items: FeedItem[] = [{ at: createdAt, sort: Date.parse(createdAt), variant: 'created' }];
  for (const e of history ?? []) {
    items.push({ at: e.at, entry: e, sort: Date.parse(e.at), variant: 'transition' });
  }
  for (const a of annotations ?? []) {
    items.push({
      at: a.created_at,
      content: a.content,
      sort: Date.parse(a.created_at),
      variant: 'annotation',
    });
  }
  return items.toSorted((a, b) => a.sort - b.sort);
}

/** Human label + optional detail for a transition_log entry (mirrors the verbs that wrote it). */
function describeTransition(e: WireHistoryEntry): { label: string; detail?: string } {
  switch (e.kind) {
    case 'lifecycle': {
      if (e.to === 'under_review') {
        return { label: 'Submitted for review' };
      }
      if (e.from === 'under_review' && e.to === 'in_progress') {
        return { label: 'Changes requested' };
      }
      if (e.to === 'in_progress') {
        return { label: 'Started' };
      }
      if (e.to === 'done') {
        return { label: e.from === 'under_review' ? 'Approved' : 'Completed' };
      }
      if (e.to === 'abandoned') {
        return { label: 'Abandoned' };
      }
      return { label: `→ ${e.to ?? '?'}` };
    }
    case 'hold': {
      if (e.to === 'parked') {
        return { label: 'Parked' };
      }
      if (e.to === 'blocked') {
        return { label: 'Blocked' };
      }
      if (e.from === 'parked') {
        return { label: 'Unparked' };
      }
      if (e.from === 'blocked') {
        return { label: 'Unblocked' };
      }
      return { label: 'Resumed' };
    }
    case 'dependency': {
      return e.from === null
        ? { detail: e.to ?? undefined, label: 'Dependency added' }
        : { detail: e.from ?? undefined, label: 'Dependency removed' };
    }
    case 'move': {
      return { detail: `${e.from ?? '—'} → ${e.to ?? '—'}`, label: 'Reparented' };
    }
    default: {
      return { label: 'Unknown' };
    }
  }
}

/** Filled dot color per transition destination; unmapped destinations stay neutral. */
const TRANSITION_DOT: Record<string, string> = {
  abandoned: 'bg-status-abandoned',
  blocked: 'bg-status-blocked',
  done: 'bg-status-done',
  in_progress: 'bg-status-in-progress',
  parked: 'bg-status-parked',
  under_review: 'bg-status-under-review',
};

/** Hold-reason callout wash, keyed to the hold kind (parked ≠ blocked hue). */
const HOLD_CALLOUT: Record<'blocked' | 'parked', { box: string; label: string }> = {
  blocked: {
    box: 'bg-status-blocked/10 inset-ring-status-blocked/24',
    label: 'text-status-blocked',
  },
  parked: {
    box: 'bg-status-parked/10 inset-ring-status-parked/24',
    label: 'text-status-parked',
  },
};

/** Timeline dot: filled (status-colored) for transitions/creation, outlined for notes. */
function FeedDot({ item }: { item: FeedItem }) {
  if (item.variant === 'annotation') {
    return (
      <span
        aria-hidden
        className="mt-1 size-[7px] shrink-0 rounded-full border-[1.5px] border-ink-dim bg-transparent"
      />
    );
  }
  const fill =
    item.variant === 'transition'
      ? (TRANSITION_DOT[item.entry.to ?? ''] ?? 'bg-ink-dim')
      : 'bg-ink-faint';
  return <span aria-hidden className={cn('mt-1 size-[7px] shrink-0 rounded-full', fill)} />;
}

function TransitionLine({ entry }: { entry: WireHistoryEntry }) {
  const { label, detail } = describeTransition(entry);
  return (
    <p className="text-meta text-ink">
      <span className="font-medium">{label}</span>
      {detail != null && <span className="ml-1.5 font-mono text-tag text-ink-dim">{detail}</span>}
      {entry.reason != null && <span className="text-ink-dim"> — {entry.reason}</span>}
    </p>
  );
}

/** A note that clamps to 3 lines, revealing "Show all ⌄" only when it overflows. */
function TimelineNote({ content }: { content: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Total rendered line count (measured while clamped), so the expand affordance
  // can carry the handoff-of-record copy "Show all · N lines ⌄" (brief §2).
  const [lines, setLines] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }
    const lh = Number.parseFloat(getComputedStyle(el).lineHeight);
    if (Number.isFinite(lh) && lh > 0) {
      setLines(Math.round(el.scrollHeight / lh));
    } else {
      // No computed line-height (jsdom): fall back to bare overflow detection.
      setLines(el.scrollHeight - el.clientHeight > 1 ? 4 : 0);
    }
  }, [content]);
  const overflowing = lines > 3;
  return (
    <div className="flex flex-col gap-0.5">
      <p
        ref={ref}
        className={cn(
          'text-meta leading-relaxed whitespace-pre-wrap text-ink',
          !expanded && 'line-clamp-3',
        )}
      >
        {content}
      </p>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="self-start text-micro text-accent-foreground transition-colors hover:text-accent"
        >
          {expanded ? 'Show less ⌃' : `Show all · ${String(lines)} lines ⌄`}
        </button>
      )}
    </div>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  return (
    <li className="flex gap-2.5">
      <FeedDot item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {item.variant === 'created' && <span className="text-meta text-ink-dim">Created</span>}
        {item.variant === 'transition' && <TransitionLine entry={item.entry} />}
        {item.variant === 'annotation' && <TimelineNote content={item.content} />}
        <time className="font-mono text-micro text-ink-faint">{ago(item.at)}</time>
      </div>
    </li>
  );
}

/** The right column: All/Activity/Notes tabs, bounded feed with a fade edge, pinned composer. */
function Timeline({
  createdAt,
  history,
  annotations,
  pending,
  nodeId,
  offline,
}: {
  createdAt: string;
  history: readonly WireHistoryEntry[] | undefined;
  annotations: readonly WireAnnotation[] | undefined;
  pending: boolean;
  nodeId: string;
  offline?: boolean;
}) {
  const feed = buildFeed(createdAt, history, annotations);
  const activity = feed.filter((i) => i.variant !== 'annotation');
  const notes = feed.filter((i) => i.variant === 'annotation');

  const panel = (items: FeedItem[], empty: string) => {
    if (pending && items.length === 0) {
      return <Skeleton className="h-12 w-full" />;
    }
    if (items.length === 0) {
      return <p className="text-xs text-ink-faint">{empty}</p>;
    }
    return (
      <ol className="flex flex-col gap-3">
        {items.map((i, idx) => (
          // Index disambiguates same-millisecond entries (two annotations can share
          // created_at), which `${variant}-${at}-${sort}` alone would collide on.
          <FeedRow key={`${i.variant}-${i.sort}-${String(idx)}`} item={i} />
        ))}
      </ol>
    );
  };

  // The shared TabsTrigger base carries `.microlabel` (uppercase + text-micro);
  // the dossier tabs are mixed-case per brief §2, so reset transform/tracking/size.
  const tabClass =
    'flex-none rounded-none border-b-2 border-transparent px-1 py-2.5 text-meta font-medium tracking-normal normal-case data-[selected]:border-accent data-[selected]:bg-transparent data-[selected]:text-ink-bright';

  return (
    <Tabs defaultValue="all" className="flex min-h-0 flex-col bg-well-recessed">
      <TabsList className="gap-4 rounded-none border-0 border-b border-line bg-transparent px-4 py-0">
        <TabsTrigger value="all" className={tabClass}>
          All · {feed.length}
        </TabsTrigger>
        <TabsTrigger value="activity" className={tabClass}>
          Activity
        </TabsTrigger>
        <TabsTrigger value="notes" className={tabClass}>
          Notes
        </TabsTrigger>
      </TabsList>
      <div className="relative min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="p-4">
            <TabsContent value="all">{panel(feed, 'Nothing yet.')}</TabsContent>
            <TabsContent value="activity">{panel(activity, 'No activity yet.')}</TabsContent>
            <TabsContent value="notes">{panel(notes, 'No notes yet.')}</TabsContent>
          </div>
        </ScrollArea>
        {/* Fade edge — chrome, not a primitive: single-use bottom gradient. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-well-recessed to-transparent" />
      </div>
      <div className="border-t border-line px-4 py-2.5">
        <AnnotationComposer nodeId={nodeId} offline={offline} />
      </div>
    </Tabs>
  );
}

/**
 * The verdict block — first in the left column, and only when a review is
 * pending. Approve fires `done` immediately; Return opens the reason dialog.
 * The submitted-summary line is DERIVED (gap 1): the latest annotation authored
 * at/after the submit; the external ref is the real `external_ref` field. No
 * summary text is fabricated when neither exists.
 */
function VerdictBlock({
  node,
  annotations,
  offline,
  onVerb,
}: {
  node: WireNode;
  annotations: readonly WireAnnotation[] | undefined;
  offline?: boolean;
  onVerb: (v: VerbSpec) => void;
}) {
  const verbs = availableTransitions(node.status);
  const doneSpec = verbs.find((v) => v.verb === 'done');
  const returnSpec = verbs.find((v) => v.verb === 'return');
  const summary = verdictSummary(node.history, annotations);

  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-gradient-to-br from-attention/10 to-attention/[0.03] p-3.5 inset-ring inset-ring-attention/35">
      {summary !== undefined && <p className="text-xs leading-relaxed text-ink">{summary}</p>}
      {node.external_ref != null && <ExternalRef value={node.external_ref} />}
      <div className="flex gap-2">
        {doneSpec !== undefined && (
          <ActionButton
            size="sm"
            variant="attention"
            disabled={offline}
            onClick={() => onVerb(doneSpec)}
          >
            Approve
          </ActionButton>
        )}
        {returnSpec !== undefined && (
          <ActionButton
            size="sm"
            variant="outline"
            disabled={offline}
            onClick={() => onVerb(returnSpec)}
          >
            Return with notes…
          </ActionButton>
        )}
      </div>
    </div>
  );
}

/** DERIVED: the latest annotation authored at/after the submit into review, if any. */
function verdictSummary(
  history: readonly WireHistoryEntry[] | undefined,
  annotations: readonly WireAnnotation[] | undefined,
): string | undefined {
  const lastSubmit = (history ?? []).findLast(
    (e) => e.kind === 'lifecycle' && e.to === 'under_review',
  );
  if (lastSubmit === undefined) {
    return undefined;
  }
  const submittedAt = Date.parse(lastSubmit.at);
  const latest = (annotations ?? [])
    .filter((a) => Date.parse(a.created_at) >= submittedAt)
    .toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .at(-1);
  return latest?.content;
}

function DossierBody({
  nodeId,
  onOpenNode,
  offline,
}: {
  nodeId: string;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const navigate = useNavigate();
  const node = useQuery(nodeQuery(nodeId));
  const annotations = useQuery(annotationsQuery(nodeId));
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const update = useUpdateNode(nodeId);
  const { mutate: transition } = useTransition(nodeId);
  const [reasonVerb, setReasonVerb] = useState<VerbSpec | null>(null);

  // Breadcrumb: the node record carries only the parent id, so fetch the parent
  // to title the crumb; it degrades to the bare id until (or unless) that loads.
  const parentId = node.data?.parent ?? undefined;
  const parent = useQuery({ ...nodeQuery(parentId ?? ''), enabled: parentId !== undefined });

  function fireVerb(v: VerbSpec) {
    if (v.needsReason) {
      setReasonVerb(v);
    } else {
      transition({ verb: v.verb });
    }
  }

  function handleEditSubmit(values: TaskFormSubmit) {
    update.mutate(
      {
        description: values.description ?? undefined,
        external_ref: values.external_ref ?? undefined,
        priority: values.priority ?? undefined,
        size: values.size ?? undefined,
        summary: values.summary ?? undefined,
        title: values.title,
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  const data = node.data;
  // Under review surfaces done/return inline (Approve/Return) — drop them from
  // the header chip row so a verb never appears twice.
  const headerVerbs =
    data === undefined
      ? []
      : availableTransitions(data.status).filter((v) =>
          data.status === 'under_review' ? v.verb !== 'done' && v.verb !== 'return' : true,
        );

  return (
    <>
      {/* The dialog's accessible name in every state (loading/editing/record);
          kept distinct from the visible left-column title heading. */}
      <Dialog.Title className="sr-only">
        {data !== undefined ? `${data.title} · ${nodeId}` : nodeId}
      </Dialog.Title>
      <header className="flex items-center gap-2.5 border-b border-line px-5 py-4">
        <span className="shrink-0 whitespace-nowrap font-mono text-mono-id text-ink-faint">
          {nodeId}
        </span>
        {data !== undefined && <StatusBadge status={data.status} pill />}
        {parentId !== undefined && (
          <span className="hidden min-w-0 items-baseline gap-1 truncate text-tag text-ink-dim sm:flex">
            {parent.data?.title !== undefined && (
              <span className="truncate">{parent.data.title}</span>
            )}
            {parent.data?.title !== undefined && <span className="text-ink-faint">›</span>}
            <span className="font-mono text-ink-faint">{parentId}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {data !== undefined && !editing && (
            <>
              {headerVerbs.map((v) => (
                <VerbChip key={v.verb} disabled={offline} onClick={() => fireVerb(v)}>
                  {v.label}
                  {v.needsReason && '…'}
                </VerbChip>
              ))}
              {/* Move… only for tasks: parentOptions() enumerates initiative/
                  phase parents (the valid targets for a task), so the picker has
                  no valid selection for a non-task node — gating here avoids the
                  broken/no-op picker an initiative or phase would otherwise open. */}
              {data.type === 'task' && (
                <VerbChip disabled={offline} onClick={() => setMoving(true)}>
                  Move…
                </VerbChip>
              )}
              {offline !== true && data.type === 'task' && (
                <VerbChip onClick={() => setEditing(true)}>Edit</VerbChip>
              )}
            </>
          )}
          <Dialog.Close
            aria-label="Close"
            className="rounded px-2 py-1 text-ink-faint transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
          >
            ✕
          </Dialog.Close>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-h-0 overflow-y-auto border-line md:border-r" data-testid="dossier-body">
          {node.isPending && (
            <div className="flex flex-col gap-2 p-5">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}
          {node.isError && data === undefined && (
            <p className="p-5 text-xs text-status-blocked">Couldn't load {nodeId}.</p>
          )}

          {data !== undefined && editing && (
            <div className="p-5">
              <TaskForm
                mode="edit"
                initial={fromNode(data)}
                submitting={update.isPending}
                onSubmit={handleEditSubmit}
                onCancel={() => setEditing(false)}
              />
            </div>
          )}

          {data !== undefined && !editing && (
            <div className="flex flex-col gap-4 p-5">
              <h2 className="text-dossier leading-[1.4] font-semibold text-ink-bright">
                {data.title}
              </h2>

              {data.status === 'under_review' && (
                <VerdictBlock
                  node={data}
                  annotations={annotations.data?.items}
                  offline={offline}
                  onVerb={fireVerb}
                />
              )}

              {(data.hold === 'parked' || data.hold === 'blocked') &&
                data.hold_reason != null &&
                data.hold_reason.trim() !== '' && (
                  <div
                    className={cn(
                      'rounded-lg p-2.5 text-xs text-ink inset-ring',
                      HOLD_CALLOUT[data.hold].box,
                    )}
                  >
                    <span className={cn('microlabel mr-2', HOLD_CALLOUT[data.hold].label)}>
                      {data.hold}
                    </span>
                    {data.hold_reason}
                  </div>
                )}

              {data.description != null && data.description.trim() !== '' && (
                <section className="flex flex-col gap-1.5">
                  <Microlabel>Description</Microlabel>
                  <p className="text-body leading-[1.65] whitespace-pre-wrap text-ink">
                    {data.description}
                  </p>
                </section>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {(data.open_ended === true ||
                  data.priority != null ||
                  data.size != null ||
                  data.verdicts?.stale === true ||
                  (data.tags?.length ?? 0) > 0) && (
                  <section className="flex flex-col gap-1.5">
                    <Microlabel>Signals</Microlabel>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {data.open_ended === true && <OpenEndedBadge />}
                      {data.priority != null && <PriorityBadge priority={data.priority} />}
                      {data.size != null && <SizeBadge size={data.size} />}
                      {data.verdicts?.stale === true && <StaleBadge />}
                      {data.tags?.map((t) => (
                        <Badge key={t.tag} variant="mono">
                          {t.tag}
                        </Badge>
                      ))}
                    </div>
                  </section>
                )}

                {data.deps !== undefined &&
                  (data.deps.depends_on.length > 0 ||
                    (data.deps.awaiting_on?.length ?? 0) > 0 ||
                    data.deps.blocking.length > 0) && (
                    <section className="flex flex-col gap-1.5">
                      <Microlabel>Blocking</Microlabel>
                      <div className="flex flex-col gap-0.5">
                        {data.deps.depends_on.map((r) => (
                          <RefRow key={`dep-${r.id}`} refNode={r} onOpenNode={onOpenNode} />
                        ))}
                        {data.deps.awaiting_on?.map((r) => (
                          <RefRow key={`await-${r.id}`} refNode={r} onOpenNode={onOpenNode} />
                        ))}
                        {data.deps.blocking.map((r) => (
                          <RefRow key={`block-${r.id}`} refNode={r} onOpenNode={onOpenNode} />
                        ))}
                      </div>
                    </section>
                  )}
              </div>

              {(data.artifacts?.length ?? 0) > 0 && (
                <section className="flex flex-col gap-1.5">
                  <Microlabel>Artifacts · {data.artifacts?.length}</Microlabel>
                  <div className="flex flex-wrap gap-1.5">
                    {data.artifacts?.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => {
                          void navigate({ search: { a: a.id, from: nodeId }, to: '/artifacts' });
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-ink-dim inset-ring inset-ring-line transition-colors hover:bg-well-800 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        <span aria-hidden className="text-accent-foreground select-none">
                          ❄
                        </span>
                        <span className="truncate">{a.title}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Meta rows carried forward from the retired drawer: target,
                  external ref, and the created/updated/completed timestamps —
                  the dossier's only home for these fields. external_ref rides the
                  verdict block while under_review, so it's shown here otherwise. */}
              <section className="flex flex-col gap-1.5">
                <Microlabel>Details</Microlabel>
                <dl className="flex flex-col gap-1">
                  {data.target != null && <MetaRow label="target">{data.target}</MetaRow>}
                  {data.status !== 'under_review' && data.external_ref != null && (
                    <MetaRow label="external ref">
                      <ExternalRef value={data.external_ref} />
                    </MetaRow>
                  )}
                  <MetaRow label="created">{absoluteTime(data.created_at)}</MetaRow>
                  <MetaRow label="updated">{absoluteTime(data.updated_at)}</MetaRow>
                  {data.completed_at != null && (
                    <MetaRow label="completed">{absoluteTime(data.completed_at)}</MetaRow>
                  )}
                </dl>
              </section>
            </div>
          )}
        </div>

        {data !== undefined && (
          <Timeline
            createdAt={data.created_at}
            history={data.history}
            annotations={annotations.data?.items}
            pending={annotations.isPending}
            nodeId={data.id}
            offline={offline}
          />
        )}
      </div>

      <ReasonDialog
        verb={reasonVerb?.verb ?? null}
        open={reasonVerb !== null}
        onClose={() => setReasonVerb(null)}
        onConfirm={(reason) => {
          if (reasonVerb !== null) {
            transition(
              reason === '' ? { verb: reasonVerb.verb } : { reason, verb: reasonVerb.verb },
            );
          }
          setReasonVerb(null);
        }}
      />
      {data !== undefined && (
        <MoveDialog
          nodeId={nodeId}
          currentParent={data.parent}
          open={moving}
          onClose={() => setMoving(false)}
        />
      )}
    </>
  );
}
