import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { NodeRef } from "@mimir/contract";
import type { ReactNode } from "react";
import { annotationsQuery, nodeQuery } from "../api/queries";
import { absoluteTime, ago } from "../lib/time";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "./ui/sheet";
import { Skeleton } from "./ui/skeleton";
import { PriorityBadge, SizeBadge, StaleBadge } from "./signal-badges";
import { StatusBadge } from "./status-badge";
import { StatusDot } from "./status-dot";
import { TransitionMenu } from "./transition-menu";

/**
 * The node-detail drawer — URL-addressable (`?node=KEY-seq`), layered over
 * whichever view is open. Chunk-1 scope: the full record, signals, deps,
 * tags, annotations, and artifact *titles* (bodies and transition history
 * are chunk 3). Chunk-2 adds the transition kebab.
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
        if (!open) onClose();
      }}
    >
      {nodeId !== undefined && (
        <SheetContent aria-describedby={undefined}>
          <DrawerBody nodeId={nodeId} onOpenNode={onOpenNode} offline={offline} />
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
    <div className="flex justify-between gap-3 text-[11.5px]">
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
      className="flex items-center gap-2 rounded-[3px] px-1 py-0.5 text-left text-[12px] text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {refNode.status !== undefined && <StatusDot status={refNode.status} />}
      <span className="font-mono text-[11px] text-accent">{refNode.id}</span>
    </button>
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

  return (
    <>
      <header className="flex items-start justify-between gap-3 border-b border-line p-4 pb-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] font-semibold text-ink-dim">{nodeId}</span>
            {node.data !== undefined && (
              <>
                <Badge variant="outline">{node.data.type}</Badge>
                <StatusBadge status={node.data.status} />
              </>
            )}
          </div>
          <SheetTitle className="text-[15px] leading-snug font-semibold text-ink-bright">
            {node.data?.title ?? nodeId}
          </SheetTitle>
        </div>
        <div className="flex items-center gap-1">
          {node.data !== undefined && (
            <TransitionMenu node={{ id: nodeId, status: node.data.status }} disabled={offline} />
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
            <p className="text-[12px] text-status-blocked">Couldn't load {nodeId}.</p>
          )}

          {node.data !== undefined && (
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

              {node.data.hold_reason != null && node.data.hold !== "none" && (
                <div className="rounded border border-status-blocked/40 bg-status-blocked/10 p-2.5 text-[12px] text-ink">
                  <span className="microlabel mr-2 text-status-blocked">{node.data.hold}</span>
                  {node.data.hold_reason}
                </div>
              )}

              {node.data.description !== null && (
                <Section label="Description">
                  <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
                    {node.data.description}
                  </p>
                </Section>
              )}

              {node.data.deps !== undefined &&
                (node.data.deps.depends_on.length > 0 || node.data.deps.blocking.length > 0) && (
                  <Section label="Dependencies">
                    {node.data.deps.depends_on.length > 0 && (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[11px] text-ink-dim">depends on</span>
                        {node.data.deps.depends_on.map((r) => (
                          <RefRow key={r.id} refNode={r} onOpenNode={onOpenNode} />
                        ))}
                      </div>
                    )}
                    {node.data.deps.blocking.length > 0 && (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[11px] text-ink-dim">blocking</span>
                        {node.data.deps.blocking.map((r) => (
                          <RefRow key={r.id} refNode={r} onOpenNode={onOpenNode} />
                        ))}
                      </div>
                    )}
                  </Section>
                )}

              {(node.data.tags?.length ?? 0) > 0 && (
                <Section label="Tags">
                  <div className="flex flex-wrap gap-1">
                    {node.data.tags?.map((t) => (
                      <Badge key={t.tag} variant="outline" title={t.note ?? undefined}>
                        {t.tag}
                      </Badge>
                    ))}
                  </div>
                </Section>
              )}

              <Section label="Annotations">
                {annotations.isPending && <Skeleton className="h-12 w-full" />}
                {annotations.data !== undefined && annotations.data.items.length === 0 && (
                  <p className="text-[12px] text-ink-faint">None.</p>
                )}
                {annotations.data !== undefined && annotations.data.items.length > 0 && (
                  <ol className="flex flex-col gap-2">
                    {annotations.data.items.map((a) => (
                      <li
                        key={`${a.created_at}-${a.content.slice(0, 24)}`}
                        className="rounded border border-line bg-well-850 p-2.5"
                      >
                        <time className="font-mono text-[10px] text-ink-faint">
                          {absoluteTime(a.created_at)} · {ago(a.created_at)}
                        </time>
                        <p className="mt-1 text-[12px] leading-relaxed whitespace-pre-wrap text-ink">
                          {a.content}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </Section>

              {(node.data.artifacts?.length ?? 0) > 0 && (
                <Section label="Artifacts">
                  <ol className="flex flex-col gap-1">
                    {node.data.artifacts?.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => {
                            void navigate({ to: "/artifacts", search: { a: a.id, from: nodeId } });
                          }}
                          className="flex w-full items-center gap-2 rounded-[3px] px-1 py-0.5 text-left text-[12px] text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          <span className="font-mono text-[10px] text-ink-dim">{a.id}</span>
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
