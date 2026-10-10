import { Dialog } from '@base-ui-components/react/dialog';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { annotationsQuery, nodeQuery } from '../api/queries';
import type { WireAnnotation, WireHistoryEntry } from '../api/types';
import { absoluteTime } from '../lib/time';
import { buildFeed } from '../lib/timeline';
import { AnnotationComposer } from './annotation-composer';
import { DirectionLine } from './direction-line';
import { MarkdownBody } from './markdown-body';
import { MoveDialog } from './move-dialog';
import {
  ExternalRef,
  HoldCallout,
  MetaRow,
  Microlabel,
  RefRow,
  SignalBadges,
  VerdictBlock,
  awaitsVerdict,
  blockingRows,
  hasSignals,
  recordVerbs,
  useNodeEdit,
  useNodeVerbs,
} from './node-record';
import { FeedList } from './node-timeline';
import { StatusBadge } from './status-badge';
import { TaskForm } from './task-form';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

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
  offline,
}: {
  nodeId: string | undefined;
  onClose: () => void;
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
            <DossierBody key={nodeId} nodeId={nodeId} offline={offline} />
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
            <TabsContent value="all">
              <FeedList items={feed} pending={pending} empty="Nothing yet." />
            </TabsContent>
            <TabsContent value="activity">
              <FeedList items={activity} pending={pending} empty="No activity yet." />
            </TabsContent>
            <TabsContent value="notes">
              <FeedList items={notes} pending={pending} empty="No notes yet." />
            </TabsContent>
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

function DossierBody({ nodeId, offline }: { nodeId: string; offline?: boolean }) {
  const navigate = useNavigate();
  const node = useQuery(nodeQuery(nodeId));
  const annotations = useQuery(annotationsQuery(nodeId));
  const edit = useNodeEdit(nodeId);
  const editing = edit.baseline !== null;
  const [moving, setMoving] = useState(false);
  const verbs = useNodeVerbs(nodeId);

  // Breadcrumb: the node record carries only the parent id, so fetch the parent
  // to title the crumb; it degrades to the bare id until (or unless) that loads.
  const parentId = node.data?.parent ?? undefined;
  const parent = useQuery({ ...nodeQuery(parentId ?? ''), enabled: parentId !== undefined });

  const data = node.data;
  // Under review surfaces done/return inline (Approve/Return) — keep them off
  // the header chip row so a verb never appears twice.
  const headerVerbs = data === undefined ? [] : recordVerbs(data);

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
                <VerbChip key={v.verb} disabled={offline} onClick={() => verbs.handleVerb(v)}>
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
                <VerbChip onClick={() => edit.begin(data)}>Edit</VerbChip>
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

          {data !== undefined && edit.baseline !== null && (
            <div className="p-5">
              <TaskForm
                mode="edit"
                initial={edit.baseline}
                submitting={edit.submitting}
                onSubmit={edit.handleSubmit}
                onCancel={edit.handleCancel}
              />
            </div>
          )}

          {data !== undefined && !editing && (
            <div className="flex flex-col gap-4 p-5">
              <h2 className="text-dossier leading-[1.4] font-semibold text-ink-bright">
                {data.title}
              </h2>

              {awaitsVerdict(data) && (
                <VerdictBlock
                  node={data}
                  annotations={annotations.data?.items}
                  offline={offline}
                  onVerb={verbs.handleVerb}
                />
              )}

              <HoldCallout node={data} />

              {/* Direction (MMR-390) is a container facet: initiatives and
                  phases own `## Next`, tasks never do. */}
              {(data.type === 'initiative' || data.type === 'phase') && (
                <DirectionLine
                  subject={{ id: data.id, kind: 'node' }}
                  title={data.title}
                  next={data.next}
                  offline={offline === true}
                />
              )}

              {data.description != null && data.description.trim() !== '' && (
                <section className="flex flex-col gap-1.5">
                  <Microlabel>Description</Microlabel>
                  <MarkdownBody breaks className="max-w-none">
                    {data.description}
                  </MarkdownBody>
                </section>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {hasSignals(data) && (
                  <section className="flex flex-col gap-1.5">
                    <Microlabel>Signals</Microlabel>
                    <SignalBadges node={data} />
                  </section>
                )}

                {data.deps !== undefined &&
                  (data.deps.depends_on.length > 0 ||
                    (data.deps.awaiting_on?.length ?? 0) > 0 ||
                    data.deps.blocking.length > 0) && (
                    <section className="flex flex-col gap-1.5">
                      <Microlabel>Blocking</Microlabel>
                      <div className="flex flex-col gap-0.5">
                        {blockingRows(data.deps).map((r) => (
                          <RefRow key={r.id} refNode={r} />
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

      {verbs.dialog}
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
