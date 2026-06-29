import type { NodeRef } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { useMoveNode, useUpdateNode } from '../api/mutations';
import { annotationsQuery, nodeQuery, treeQuery } from '../api/queries';
import { projectKeyOf } from '../api/types';
import type { WireAnnotation, WireHistoryEntry, WireNode } from '../api/types';
import { parentOptions } from '../lib/parent-options';
import type { TaskFormValues } from '../lib/schemas';
import { absoluteTime, ago } from '../lib/time';
import { AnnotationComposer } from './annotation-composer';
import { PriorityBadge, SizeBadge, StaleBadge } from './signal-badges';
import { StatusBadge } from './status-badge';
import { StatusDot } from './status-dot';
import { TagEditor } from './tag-editor';
import { TaskForm } from './task-form';
import type { TaskFormSubmit } from './task-form';
import { TransitionMenu } from './transition-menu';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/sheet';
import { Skeleton } from './ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

function fromNode(n: WireNode): TaskFormValues {
  return {
    title: n.title,
    description: n.description ?? '',
    priority: n.priority ?? '',
    size: n.size ?? '',
    external_ref: n.external_ref ?? '',
    // Edit mode hides the tags input and useUpdateNode doesn't send tags; tags are managed separately via TagEditor.
    tags: [],
  };
}

/**
 * The node-detail drawer — URL-addressable (`?node=KEY-seq`), layered over
 * whichever view is open. Shows the full record, signals, deps, tags, artifact
 * *titles*, the transition kebab, and a tabbed Timeline (transitions +
 * annotations as one chronological feed; the `history` facet on the node fetch).
 */
export function NodeDrawer({
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
    <Sheet
      open={nodeId !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      {nodeId !== undefined && (
        <SheetContent aria-describedby={undefined}>
          <DrawerBody key={nodeId} nodeId={nodeId} onOpenNode={onOpenNode} offline={offline} />
        </SheetContent>
      )}
    </Sheet>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="microlabel text-ink-faint">{label}</h3>
      {children}
    </section>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-2xs">
      <dt className="text-ink-dim">{label}</dt>
      <dd className="text-right font-mono text-ink">{value}</dd>
    </div>
  );
}

function RefRow({ refNode, onOpenNode }: { refNode: NodeRef; onOpenNode: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        onOpenNode(refNode.id);
      }}
      className="flex items-center gap-2 rounded-sm px-1 py-0.5 text-left text-xs text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {refNode.status !== undefined && <StatusDot status={refNode.status} />}
      <span className="font-mono text-2xs text-accent">{refNode.id}</span>
    </button>
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

function FeedRow({ item }: { item: FeedItem }) {
  const glyph = item.variant === 'annotation' ? '✎' : item.variant === 'created' ? '○' : '◆';
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="mt-0.5 text-2xs text-ink-faint select-none">
        {glyph}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <time className="font-mono text-3xs text-ink-faint">
          {absoluteTime(item.at)} · {ago(item.at)}
        </time>
        {item.variant === 'created' && <span className="text-xs text-ink-dim">Created</span>}
        {item.variant === 'transition' && <TransitionLine entry={item.entry} />}
        {item.variant === 'annotation' && (
          <p className="text-xs leading-relaxed whitespace-pre-wrap text-ink">{item.content}</p>
        )}
      </div>
    </li>
  );
}

function TransitionLine({ entry }: { entry: WireHistoryEntry }) {
  const { label, detail } = describeTransition(entry);
  return (
    <p className="text-xs text-ink">
      <span className="font-medium">{label}</span>
      {detail != null && <span className="ml-1.5 font-mono text-2xs text-ink-dim">{detail}</span>}
      {entry.reason != null && <span className="text-ink-dim"> — {entry.reason}</span>}
    </p>
  );
}

/** The drawer's tabbed history feed: All (merged), Activity (transitions), Notes (annotations). */
function Timeline({
  createdAt,
  history,
  annotations,
  pending,
  composer,
}: {
  createdAt: string;
  history: readonly WireHistoryEntry[] | undefined;
  annotations: readonly WireAnnotation[] | undefined;
  pending: boolean;
  composer?: ReactNode;
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
        {items.map((i) => (
          <FeedRow key={`${i.variant}-${i.at}-${i.sort}`} item={i} />
        ))}
      </ol>
    );
  };

  return (
    <Section label="Timeline">
      {composer}
      <Tabs defaultValue="all" className="flex flex-col gap-2.5">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>
        <TabsContent value="all">{panel(feed, 'Nothing yet.')}</TabsContent>
        <TabsContent value="activity">{panel(activity, 'No activity yet.')}</TabsContent>
        <TabsContent value="notes">{panel(notes, 'No notes yet.')}</TabsContent>
      </Tabs>
    </Section>
  );
}

function DrawerBody({
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
  const update = useUpdateNode(nodeId);
  const move = useMoveNode(nodeId);
  // The project tree feeds the edit-mode parent picker (initiative→phase options).
  const tree = useQuery({ ...treeQuery(projectKeyOf(nodeId)), enabled: editing });

  function handleEditSubmit(values: TaskFormSubmit) {
    update.mutate(
      {
        description: values.description ?? undefined,
        external_ref: values.external_ref ?? undefined,
        priority: values.priority ?? undefined,
        size: values.size ?? undefined,
        title: values.title,
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  return (
    <>
      <header className="flex items-start justify-between gap-3 border-b border-line p-4 pb-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-ink-dim">{nodeId}</span>
            {node.data !== undefined && (
              <>
                <Badge variant="outline">{node.data.type}</Badge>
                <StatusBadge status={node.data.status} />
              </>
            )}
          </div>
          <SheetTitle className="text-md leading-snug font-semibold text-ink-bright">
            {node.data?.title ?? nodeId}
          </SheetTitle>
        </div>
        <div className="flex items-center gap-1">
          {node.data !== undefined && (
            <>
              {!offline && node.data.type === 'task' && (
                <button
                  type="button"
                  aria-label="Edit"
                  onClick={() => setEditing(true)}
                  className="rounded px-2 py-1 text-xs text-ink-dim transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Edit
                </button>
              )}
              <TransitionMenu node={{ id: nodeId, status: node.data.status }} disabled={offline} />
            </>
          )}
          <SheetClose className="rounded px-2 py-1 text-ink-dim transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent">
            ✕
          </SheetClose>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4" data-testid="drawer-body">
          {node.isPending && (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}
          {node.isError && node.data === undefined && (
            <p className="text-xs text-status-blocked">Couldn't load {nodeId}.</p>
          )}

          {node.data !== undefined && editing && (
            <div className="flex flex-col gap-3">
              {/* Parent is a move (verb), not part of the dumb update submit (MMR-73). */}
              <div className="flex flex-col gap-1">
                <label htmlFor="drawer-parent" className="text-xs font-medium text-ink-dim">
                  Parent
                </label>
                <select
                  id="drawer-parent"
                  value={node.data.parent ?? ''}
                  disabled={tree.data === undefined || move.isPending}
                  onChange={(e) => {
                    const to = e.target.value;
                    if (to !== '' && to !== node.data?.parent) {
                      move.mutate(to);
                    }
                  }}
                  className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent disabled:opacity-50"
                >
                  {(tree.data ? parentOptions(tree.data) : []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.depth === 1 ? `  — ${o.label}` : o.label}
                    </option>
                  ))}
                </select>
              </div>
              <TaskForm
                mode="edit"
                initial={fromNode(node.data)}
                submitting={update.isPending}
                onSubmit={handleEditSubmit}
                onCancel={() => setEditing(false)}
              />
            </div>
          )}

          {node.data !== undefined && !editing && (
            <>
              {(node.data.priority != null ||
                node.data.size != null ||
                node.data.verdicts?.stale === true) && (
                <Section label="Signals">
                  <div className="flex items-center gap-1.5">
                    {node.data.priority != null && <PriorityBadge priority={node.data.priority} />}
                    {node.data.size != null && <SizeBadge size={node.data.size} />}
                    {node.data.verdicts?.stale === true && <StaleBadge />}
                  </div>
                </Section>
              )}

              {node.data.hold_reason != null && node.data.hold !== 'none' && (
                <div className="rounded border border-status-blocked/40 bg-status-blocked/10 p-2.5 text-xs text-ink">
                  <span className="microlabel mr-2 text-status-blocked">{node.data.hold}</span>
                  {node.data.hold_reason}
                </div>
              )}

              {node.data.description !== null && (
                <Section label="Description">
                  <p className="text-xs leading-relaxed whitespace-pre-wrap text-ink">
                    {node.data.description}
                  </p>
                </Section>
              )}

              {node.data.deps !== undefined &&
                (node.data.deps.depends_on.length > 0 || node.data.deps.blocking.length > 0) && (
                  <Section label="Dependencies">
                    {node.data.deps.depends_on.length > 0 && (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-2xs text-ink-dim">depends on</span>
                        {node.data.deps.depends_on.map((r) => (
                          <RefRow key={r.id} refNode={r} onOpenNode={onOpenNode} />
                        ))}
                      </div>
                    )}
                    {node.data.deps.blocking.length > 0 && (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-2xs text-ink-dim">blocking</span>
                        {node.data.deps.blocking.map((r) => (
                          <RefRow key={r.id} refNode={r} onOpenNode={onOpenNode} />
                        ))}
                      </div>
                    )}
                  </Section>
                )}

              {(!offline || (node.data.tags?.length ?? 0) > 0) && (
                <Section label="Tags">
                  <TagEditor nodeId={node.data.id} tags={node.data.tags ?? []} offline={offline} />
                </Section>
              )}

              <Timeline
                createdAt={node.data.created_at}
                history={node.data.history}
                annotations={annotations.data?.items}
                pending={annotations.isPending}
                composer={<AnnotationComposer nodeId={node.data.id} offline={offline} />}
              />

              {(node.data.artifacts?.length ?? 0) > 0 && (
                <Section label="Artifacts">
                  <ol className="flex flex-col gap-1">
                    {node.data.artifacts?.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => {
                            void navigate({ search: { a: a.id, from: nodeId }, to: '/artifacts' });
                          }}
                          className="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left text-xs text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          <span className="font-mono text-3xs text-ink-dim">{a.id}</span>
                          <span className="truncate">{a.title}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </Section>
              )}

              <Separator />

              <dl className="flex flex-col gap-1">
                {node.data.parent !== null && <MetaRow label="parent" value={node.data.parent} />}
                {node.data.target != null && <MetaRow label="target" value={node.data.target} />}
                {node.data.external_ref != null && (
                  <MetaRow label="external ref" value={node.data.external_ref} />
                )}
                <MetaRow label="created" value={absoluteTime(node.data.created_at)} />
                <MetaRow label="updated" value={absoluteTime(node.data.updated_at)} />
                {node.data.completed_at != null && (
                  <MetaRow label="completed" value={absoluteTime(node.data.completed_at)} />
                )}
              </dl>
            </>
          )}
        </div>
      </ScrollArea>
    </>
  );
}
