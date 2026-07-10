import type { StatusWord } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useTransition } from '../api/mutations';
import { annotationsQuery, nodeQuery } from '../api/queries';
import type { WireHistoryEntry, WireNode } from '../api/types';
import { cn } from '../lib/cn';
import { ago, relativeTime } from '../lib/time';
import { availableTransitions } from '../lib/transitions';
import type { VerbSpec } from '../lib/transitions';
import { describeTransition } from './node-dossier';
import { ReasonDialog } from './reason-dialog';
import { PriorityBadge, SizeBadge } from './signal-badges';
import { StatusBadge } from './status-badge';
import { ActionButton } from './ui/action-button';
import { MenuContent, MenuItem, MenuLabel, MenuRoot, MenuTrigger } from './ui/menu';
import { Skeleton } from './ui/skeleton';

/**
 * The node quick view (MMR-223) — the compact in-place preview a board card
 * opens, distinct from the full Dossier (MMR-222). Two renderings gated on the
 * board's own `md:` split: {@link QuickViewPanel} (desktop drop panel, 6a) and
 * {@link QuickShelf} (mobile bottom sheet, 6c). Both are read-only previews plus
 * a small verb set; neither reimplements the dossier.
 */

/** The panel/shelf slide duration (ms) — Esc/✕ play this exit before unmounting. */
const CLOSE_MS = 180;

/** The most recent transition_log entry (max timestamp), or undefined for none. */
function lastTransition(
  history: readonly WireHistoryEntry[] | undefined,
): WireHistoryEntry | undefined {
  if (history === undefined || history.length === 0) {
    return undefined;
  }
  return history.reduce((latest, e) => (Date.parse(e.at) > Date.parse(latest.at) ? e : latest));
}

/** The submit-for-review moment, for the verdict block's "Submitted … ago" line. */
function submittedAt(node: WireNode): string {
  const submit = (node.history ?? [])
    .filter((e) => e.kind === 'lifecycle' && e.to === 'under_review')
    .reduce<WireHistoryEntry | undefined>(
      (latest, e) =>
        latest === undefined || Date.parse(e.at) > Date.parse(latest.at) ? e : latest,
      undefined,
    );
  return submit?.at ?? node.updated_at;
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The external ref as a link when it parses as an http(s) URL, else plain underlined text. */
function ExternalRef({ value }: { value: string }) {
  if (isUrl(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-attention-solid"
      >
        {value} ↗
      </a>
    );
  }
  return <span className="underline underline-offset-2">{value} ↗</span>;
}

/** "Last note: … · timeline ↗" — shared by both right-column branches. */
function LastNoteLine({
  note,
  pending,
  onOpenTimeline,
}: {
  note: string | undefined;
  pending: boolean;
  onOpenTimeline: () => void;
}) {
  if (pending) {
    return <Skeleton className="h-3 w-40" />;
  }
  return (
    <p className="text-micro text-ink-faint">
      {note !== undefined && note !== '' ? (
        <>Last note: {note.length > 60 ? `${note.slice(0, 60)}…` : note} · </>
      ) : (
        <>No notes yet · </>
      )}
      <button
        type="button"
        onClick={onOpenTimeline}
        className="text-accent-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        timeline ↗
      </button>
    </p>
  );
}

/** The verdict block (under-review nodes) — Approve/Return plus context lines. */
function VerdictBlock({
  node,
  detail,
  note,
  notePending,
  offline,
  onOpenNode,
}: {
  node: WireNode;
  detail: WireNode | undefined;
  note: string | undefined;
  notePending: boolean;
  offline?: boolean;
  onOpenNode: (id: string) => void;
}) {
  const { mutate } = useTransition(node.id);
  const [returning, setReturning] = useState(false);
  const summary = detail?.summary ?? node.summary ?? '';
  const ref = detail?.external_ref ?? node.external_ref ?? null;

  return (
    <>
      <p className="text-tag leading-[1.5] text-attention-foreground">
        Submitted {ago(submittedAt(detail ?? node))}
        {summary !== '' && <>: “{summary}”</>}
        {ref != null && ref !== '' && (
          <>
            {' · '}
            <ExternalRef value={ref} />
          </>
        )}
      </p>
      <div className="flex gap-2">
        <ActionButton
          variant="attention"
          size="sm"
          disabled={offline}
          className="flex-1"
          onClick={() => {
            mutate({ verb: 'done' });
          }}
        >
          Approve
        </ActionButton>
        <ActionButton
          variant="outline"
          size="sm"
          disabled={offline}
          className="flex-1"
          onClick={() => {
            setReturning(true);
          }}
        >
          Return…
        </ActionButton>
        <ReasonDialog
          verb={returning ? 'return' : null}
          open={returning}
          onClose={() => {
            setReturning(false);
          }}
          onConfirm={(reason) => {
            mutate(reason === '' ? { verb: 'return' } : { reason, verb: 'return' });
            setReturning(false);
          }}
        />
      </div>
      <LastNoteLine
        note={note}
        pending={notePending}
        onOpenTimeline={() => {
          onOpenNode(node.id);
        }}
      />
    </>
  );
}

/** The status-context block (non-under-review nodes) — badge + last transition + last note. */
function StatusContext({
  node,
  detail,
  note,
  notePending,
  onOpenNode,
}: {
  node: WireNode;
  detail: WireNode | undefined;
  note: string | undefined;
  notePending: boolean;
  onOpenNode: (id: string) => void;
}) {
  const last = lastTransition(detail?.history);
  return (
    <>
      <StatusBadge status={node.status} className="self-start" />
      {last !== undefined && (
        <p className="text-tag text-ink-dim">
          {describeTransition(last).label} · {relativeTime(last.at)}
        </p>
      )}
      <LastNoteLine
        note={note}
        pending={notePending}
        onOpenTimeline={() => {
          onOpenNode(node.id);
        }}
      />
    </>
  );
}

/**
 * The desktop drop panel (6a). A full-width row inserted below the selected
 * card's band row: a two-column preview (`1.3fr 1fr`) with the description and
 * signals on the left, the verdict or status context on the right. Esc closes;
 * the open transition is a 180ms ease-out slide (Motion budget item 2).
 */
export function QuickViewPanel({
  node,
  onClose,
  onOpenNode,
  offline,
}: {
  node: WireNode;
  onClose: () => void;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const detail = useQuery(nodeQuery(node.id));
  const annotations = useQuery(annotationsQuery(node.id));
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close is animated: play the 180ms exit slide, then let the parent unmount us.
  const requestClose = useCallback(() => {
    setOpen(false);
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
    }
    closeTimer.current = setTimeout(onClose, CLOSE_MS);
  }, [onClose]);

  useEffect(() => {
    setOpen(true);
    // Esc closes the desktop drop panel only. This component is permanently
    // mounted (the swimlane is `hidden md:block`, not conditionally rendered), so
    // the listener must no-op below the md breakpoint — otherwise it would also
    // close the mobile shelf, whose sole close affordance is ✕.
    function onKey(e: KeyboardEvent) {
      const desktop = globalThis.matchMedia('(min-width: 768px)').matches;
      if (e.key === 'Escape' && desktop) {
        requestClose();
      }
    }
    globalThis.addEventListener('keydown', onKey);
    return () => {
      globalThis.removeEventListener('keydown', onKey);
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
      }
    };
  }, [requestClose]);

  const isUnderReview = node.status === 'under_review';
  const d = detail.data;
  const note = annotations.data?.items.at(-1)?.content;
  const description = d?.description ?? node.description ?? null;
  const blockingId = d?.deps?.blocking[0]?.id;
  const artifactCount = d?.artifacts?.length ?? 0;
  const priority = d?.priority ?? node.priority;
  const size = d?.size ?? node.size;

  return (
    <div
      data-testid="quick-panel"
      className={cn(
        'mt-3.5 grid grid-cols-[1.3fr_1fr] gap-5 rounded-xl border bg-well-850 px-[18px] py-4 light:shadow-menu',
        'origin-top transition-[transform,opacity] duration-[180ms] ease-out',
        open ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0',
        isUnderReview ? 'border-attention/40' : 'border-accent/40',
      )}
    >
      <div className="flex flex-col gap-[11px]">
        <div className="flex items-center gap-2.5">
          <span className="flex-1 text-[14.5px] font-semibold text-ink-bright">{node.title}</span>
          <button
            type="button"
            onClick={() => {
              onOpenNode(node.id);
            }}
            className="text-micro font-semibold text-accent-foreground hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Full dossier ↗
          </button>
          <button
            type="button"
            aria-label="Close quick view"
            onClick={requestClose}
            className="text-xs text-ink-faint hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
          >
            ✕
          </button>
        </div>
        {detail.isPending && description == null ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          description != null &&
          description !== '' && (
            <p className="line-clamp-3 text-meta leading-[1.6] text-ink">{description}</p>
          )
        )}
        {(priority != null || size != null || blockingId !== undefined || artifactCount > 0) && (
          <div className="flex items-center gap-1.5">
            {priority != null && <PriorityBadge priority={priority} />}
            {size != null && <SizeBadge size={size} />}
            {(blockingId !== undefined || artifactCount > 0) && (
              <span className="text-micro text-ink-dim">
                {blockingId !== undefined && (
                  <>
                    blocks <span className="font-mono text-ink-faint">{blockingId}</span>
                  </>
                )}
                {blockingId !== undefined && artifactCount > 0 && ' · '}
                {artifactCount > 0 && <>artifacts · {artifactCount}</>}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-[9px] border-l border-line pl-5">
        {isUnderReview ? (
          <VerdictBlock
            node={node}
            detail={d}
            note={note}
            notePending={annotations.isPending}
            offline={offline}
            onOpenNode={onOpenNode}
          />
        ) : (
          <StatusContext
            node={node}
            detail={d}
            note={note}
            notePending={annotations.isPending}
            onOpenNode={onOpenNode}
          />
        )}
      </div>
    </div>
  );
}

/** Status-hue top border for the shelf (violet for under-review, else the status hue at /50). */
const SHELF_BORDER: Record<StatusWord, string> = {
  abandoned: 'border-t-status-abandoned/50',
  awaiting: 'border-t-status-awaiting/50',
  blocked: 'border-t-status-blocked/50',
  done: 'border-t-status-done/50',
  in_progress: 'border-t-status-in-progress/50',
  new: 'border-t-status-new/50',
  parked: 'border-t-status-parked/50',
  ready: 'border-t-status-ready/50',
  under_review: 'border-t-attention/50',
};

/** One shelf verb button behavior — fires immediately, or opens the reason dialog first. */
function useVerbRunner(id: string) {
  const { mutate } = useTransition(id);
  const [reasonVerb, setReasonVerb] = useState<VerbSpec | null>(null);
  const run = (verb: VerbSpec) => {
    if (verb.needsReason) {
      setReasonVerb(verb);
    } else {
      mutate({ verb: verb.verb });
    }
  };
  const dialog = (
    <ReasonDialog
      verb={reasonVerb?.verb ?? null}
      open={reasonVerb !== null}
      onClose={() => {
        setReasonVerb(null);
      }}
      onConfirm={(reason) => {
        if (reasonVerb !== null) {
          mutate(reason === '' ? { verb: reasonVerb.verb } : { reason, verb: reasonVerb.verb });
        }
        setReasonVerb(null);
      }}
    />
  );
  return { dialog, run };
}

/**
 * The mobile shelf (6c). A fixed bottom sheet: drag handle, id + status pill +
 * close, title, 2-line description, and ≥44px actions — the primary verb, a
 * "Verbs…" menu for the rest, and "Dossier ↗". Under review swaps the primary
 * slot for the same **Approve** / **Return…** verdict pair the desktop drop
 * panel shows (MMR-258): Approve fires `done` directly, Return… opens the
 * reason dialog for `return`; the remaining verbs (park/block/abandon) still
 * land under "Verbs…". The handle is decorative (no drag-to-dismiss in this
 * scope); ✕ closes. 180ms ease-out slide-up.
 */
export function QuickShelf({
  node,
  onClose,
  onOpenNode,
  offline,
}: {
  node: WireNode;
  onClose: () => void;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const detail = useQuery(nodeQuery(node.id));
  const [open, setOpen] = useState(false);
  const { run, dialog } = useVerbRunner(node.id);
  const shelfRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close is animated: play the 180ms slide-down, then let the parent unmount us.
  const requestClose = useCallback(() => {
    setOpen(false);
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
    }
    closeTimer.current = setTimeout(onClose, CLOSE_MS);
  }, [onClose]);

  useEffect(() => {
    setOpen(true);
    // The shelf is a focused preview: move focus into it on open and restore it
    // to the triggering card on unmount (it replaced a focus-managed dialog).
    const previous = document.activeElement;
    shelfRef.current?.focus();
    return () => {
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
      }
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    };
  }, []);

  const verbs = availableTransitions(node.status);
  const isUnderReview = node.status === 'under_review';
  // Under review, done/return move out of the generic primary slot into the
  // Approve/Return verdict pair below; everything else still falls to Verbs….
  const primary = isUnderReview ? undefined : verbs[0];
  const rest = isUnderReview
    ? verbs.filter((v) => v.verb !== 'done' && v.verb !== 'return')
    : verbs.slice(1);
  const approveVerb = verbs.find((v) => v.verb === 'done');
  const returnVerb = verbs.find((v) => v.verb === 'return');
  const description = detail.data?.description ?? node.description ?? null;

  return (
    <div
      ref={shelfRef}
      data-testid="quick-shelf"
      role="dialog"
      aria-label={`Quick view: ${node.title}`}
      tabIndex={-1}
      // The shelf lives inside the mobile board's swipe-handler div; without this
      // a horizontal drag on the shelf would bubble up and flip the board tab.
      onTouchStart={(e) => {
        e.stopPropagation();
      }}
      onTouchEnd={(e) => {
        e.stopPropagation();
      }}
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 flex flex-col gap-2.5 rounded-t-[18px] border-t-2 bg-well-850 px-4 pt-2.5 pb-5 focus:outline-none',
        'transition-transform duration-[180ms] ease-out dark:shadow-[0_-12px_34px_rgba(0,0,0,0.55)] light:shadow-overlay',
        open ? 'translate-y-0' : 'translate-y-full',
        SHELF_BORDER[node.status],
      )}
    >
      <span aria-hidden className="mx-auto h-1 w-9 rounded-full bg-line-bright" />
      <div className="flex items-center gap-2">
        <span className="font-mono text-mono-id text-ink-faint">{node.id}</span>
        <StatusBadge status={node.status} />
        <button
          type="button"
          aria-label="Close quick view"
          onClick={requestClose}
          className="ml-auto text-ink-faint hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
        >
          ✕
        </button>
      </div>
      <p className="text-card-mobile font-semibold leading-[1.45] text-ink-bright">{node.title}</p>
      {description != null && description !== '' && (
        <p className="line-clamp-2 text-meta leading-[1.6] text-ink">{description}</p>
      )}
      {isUnderReview && (
        <div className="flex gap-2">
          {approveVerb !== undefined && (
            <ActionButton
              variant="attention"
              disabled={offline}
              className="min-h-11 flex-1"
              onClick={() => {
                run(approveVerb);
              }}
            >
              Approve
            </ActionButton>
          )}
          {returnVerb !== undefined && (
            <ActionButton
              variant="outline"
              disabled={offline}
              className="min-h-11 flex-1"
              onClick={() => {
                run(returnVerb);
              }}
            >
              Return…
            </ActionButton>
          )}
        </div>
      )}
      <div className="flex gap-2">
        {primary !== undefined && (
          <ActionButton
            variant="action"
            disabled={offline}
            className="min-h-11 flex-1"
            onClick={() => {
              run(primary);
            }}
          >
            {primary.label}
          </ActionButton>
        )}
        {rest.length > 0 && (
          <MenuRoot>
            <MenuTrigger
              disabled={offline}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 py-1.5 text-body font-semibold whitespace-nowrap text-ink transition-colors inset-ring inset-ring-line-bright hover:bg-line/50 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40"
            >
              Verbs…
            </MenuTrigger>
            <MenuContent>
              <MenuLabel>Transition</MenuLabel>
              {rest.map((v) => (
                <MenuItem
                  key={v.verb}
                  className="min-h-11"
                  onClick={() => {
                    run(v);
                  }}
                >
                  {v.label}
                </MenuItem>
              ))}
            </MenuContent>
          </MenuRoot>
        )}
        <ActionButton
          variant="outline"
          className="min-h-11 flex-1"
          onClick={() => {
            onOpenNode(node.id);
          }}
        >
          Dossier ↗
        </ActionButton>
      </div>
      {dialog}
    </div>
  );
}
