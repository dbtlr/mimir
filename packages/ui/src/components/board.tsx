import { Dialog } from '@base-ui-components/react/dialog';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Distribution, StatusWord } from '@mimir/contract';
import { useRef, useState } from 'react';

import { useReorder } from '../api/mutations';
import type { WireNode, WireTreeNode } from '../api/types';
import { SWIMLANE_COLUMNS, SWIMLANE_RANKABLE, buildBands } from '../lib/bands';
import type { Band, BandMode, SwimlaneColumn } from '../lib/bands';
import { BOARD_COLUMNS } from '../lib/board';
import type { Board, BoardColumn } from '../lib/board';
import { cn } from '../lib/cn';
import { reorderArgs } from '../lib/reorder';
import type { ReorderArgs } from '../lib/reorder';
import { STATUS_META, STATUS_ORDER } from '../lib/status';
import { BoardCard } from './board-card';
import { DistributionBar } from './distribution-bar';
import { QuickShelf, QuickViewPanel } from './node-quick-view';
import { StatusDot } from './status-dot';
import { statusChipVariants } from './ui/badge';

type BoardViewProps = {
  board: Board;
  /** The swimlane grouping (`?bands=`); `off` drops the spine to a flat grid. */
  bands: BandMode;
  /** The whole-project tree — feeds phase-mode ancestry; absent degrades to flat. */
  tree?: WireTreeNode;
  onOpenNode: (id: string) => void;
  offline?: boolean;
  /** All-nine status tally (the project rollup) — the mobile sheet's `new`/`abandoned` counts. */
  distribution?: Distribution;
  /** Total completed tasks fetched (before the Done window) — the `m` in "n of m". */
  doneTotal: number;
  /** Drill from Done into the `/tasks` browser (kept a callback so the board stays router-free). */
  onViewDone: () => void;
};

/** The rankable set (ADR 0007) as board columns — drag-to-reorder lives here only. */
export const RANKABLE_COLUMNS = ['in_progress', 'ready', 'awaiting'] as const;

/** The ordered ids of a column (rank order as served). */
export function columnIds(board: Board, column: BoardColumn): string[] {
  return board[column].map((n) => n.id);
}

/** A drop within a column → the reorder body, or null for a no-op. */
export function dropToReorder(
  activeId: string,
  overId: string,
  orderedIds: readonly string[],
): ReorderArgs | null {
  return reorderArgs(activeId, overId, orderedIds);
}

/** The held set (parked/blocked/awaiting) as the HELD-ledge order (MMR-221 §2.2). */
const HELD_PILLS = ['parked', 'blocked', 'awaiting'] as const;

/**
 * One HELD-ledge counter. Three states: the default outlined pill; a "ghost"
 * pill when the count is zero (label + count both drop to ghost ink); and — for
 * Blocked with work in it only — the red blocked wash (the canonical `/12` +
 * `/24` idiom). Parked never turns red; a zero Blocked is a plain ghost.
 */
function HeldPill({ column, count }: { column: (typeof HELD_PILLS)[number]; count: number }) {
  const zero = count === 0;
  const blockedHot = column === 'blocked' && count > 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-tag',
        !blockedHot && 'inset-ring inset-ring-line',
        blockedHot &&
          'bg-status-blocked/12 text-status-blocked-foreground inset-ring inset-ring-status-blocked/24',
      )}
    >
      <span
        className={cn(
          zero && !blockedHot ? 'text-ink-ghost' : 'text-ink-dim',
          blockedHot && 'text-status-blocked-foreground',
        )}
      >
        {STATUS_META[column].label}
      </span>
      <span
        className={cn(
          'font-semibold tabular-nums',
          zero && !blockedHot && 'font-normal text-ink-ghost',
          !zero && !blockedHot && 'text-ink-bright',
          blockedHot && 'text-status-blocked-foreground',
        )}
      >
        {count}
      </span>
    </span>
  );
}

/** The HELD ledge — project-wide parked/blocked/awaiting counters (never band-filtered). */
function HeldLedge({ board }: { board: Board }) {
  return (
    <div className="flex items-center gap-2.5 pb-3">
      <span className="microlabel text-ink-ghost">HELD</span>
      {HELD_PILLS.map((column) => (
        <HeldPill key={column} column={column} count={board[column].length} />
      ))}
    </div>
  );
}

/**
 * A status column header: `● <Label> · <count>` in the status color. Ready /
 * In progress / Under review carry the live column count; Done carries the
 * fixed `7d` window tag (its real N-of-M lives in the drill-through footer).
 */
function StatusColumnHeader({ column, count }: { column: SwimlaneColumn; count: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <StatusDot status={column} />
      <span className={cn('microlabel', STATUS_META[column].text)}>
        {STATUS_META[column].label}
      </span>
      <span className="text-micro text-ink-faint tabular-nums">
        · {column === 'done' ? '7d' : count}
      </span>
    </div>
  );
}

/** The band spine (leftmost 170px cell) — name, mono id + kind, and the mini bar. */
function BandSpine({ band }: { band: Band }) {
  const node = band.node;
  const kind = band.openEnded ? 'standing' : (node?.type ?? '');
  return (
    <div className="flex flex-col gap-1.5 pt-0.5">
      <div
        className={cn(
          'text-meta leading-[1.3] font-semibold',
          band.muted === true ? 'text-ink-faint' : 'text-ink-bright',
        )}
      >
        {band.name}
        {band.openEnded && <span className="font-normal text-ink-faint"> ∞</span>}
      </div>
      {node !== undefined && (
        <div className="font-mono text-mono-id text-ink-faint">
          {node.id} · {kind}
        </div>
      )}
      {band.openEnded ? (
        <p className="text-micro text-ink-ghost">open for filing</p>
      ) : (
        <DistributionBar distribution={band.distribution} className="h-1 w-[110px]" />
      )}
    </div>
  );
}

/** Done's drill-through — one slim row under the whole grid, right-aligned to Done. */
function SwimlaneDoneFooter({
  shown,
  total,
  onViewDone,
  spine,
}: {
  shown: number;
  total: number;
  onViewDone: () => void;
  spine: boolean;
}) {
  return (
    <div className="grid gap-3 pt-2" style={{ gridTemplateColumns: gridTemplate(spine) }}>
      <div className="text-right" style={{ gridColumn: '-2 / -1' }}>
        <button
          type="button"
          onClick={onViewDone}
          className="text-micro text-ink-ghost transition-colors hover:text-ink-dim focus-visible:outline-2 focus-visible:outline-accent"
        >
          {total > shown ? `${shown} of ${total} recent · all →` : `${total} done · all →`}
        </button>
      </div>
    </div>
  );
}

const SPINE_TRACK = '170px';

/** The swimlane grid template — a leading 170px spine unless the spine is dropped (off mode). */
function gridTemplate(spine: boolean): string {
  return spine ? `${SPINE_TRACK} repeat(4, minmax(0, 1fr))` : 'repeat(4, minmax(0, 1fr))';
}

/** The swimlane draggable: useSortable feeds the grip + ref into BoardCard. */
function SortableBoardCard({
  node,
  column,
  onQuickOpen,
  offline,
  selected,
}: {
  node: WireNode;
  column: SwimlaneColumn;
  onQuickOpen: (id: string) => void;
  offline?: boolean;
  selected?: boolean;
}) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    disabled: offline,
    id: node.id,
  });
  return (
    <BoardCard
      node={node}
      column={column}
      onOpen={onQuickOpen}
      offline={offline}
      selected={selected}
      sortable={{
        handleProps: { ...attributes, ...listeners },
        isDragging,
        setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
      }}
    />
  );
}

/**
 * One band × status cell. Ready / In progress are rankable: their cards wrap in
 * a SortableContext so drag-to-reorder works; the DndContext resolves the drop
 * project-wide (rank is per status word, not per band — §6), so a card can move
 * across bands within the same column. Under review / Done are static.
 */
function SwimlaneColumnCell({
  band,
  column,
  onQuickOpen,
  offline,
  quickId,
}: {
  band: Band;
  column: SwimlaneColumn;
  onQuickOpen: (id: string) => void;
  offline?: boolean;
  quickId: string | null;
}) {
  const items = band.columns[column];
  if (items.length === 0) {
    return <div />;
  }
  const rankable = SWIMLANE_RANKABLE.includes(column);
  const list = (
    <ol aria-label={STATUS_META[column].label} className="flex flex-col gap-1.5">
      {items.map((node) => (
        <li key={node.id}>
          {rankable ? (
            <SortableBoardCard
              node={node}
              column={column}
              onQuickOpen={onQuickOpen}
              offline={offline}
              selected={node.id === quickId}
            />
          ) : (
            <BoardCard
              node={node}
              column={column}
              onOpen={onQuickOpen}
              offline={offline}
              selected={node.id === quickId}
            />
          )}
        </li>
      ))}
    </ol>
  );
  return rankable ? (
    <SortableContext items={items.map((n) => n.id)} strategy={verticalListSortingStrategy}>
      {list}
    </SortableContext>
  ) : (
    list
  );
}

/** The selected quick-view node if it lives in this band — the drop-panel anchor. */
function quickNodeInBand(band: Band, quickId: string | null): WireNode | undefined {
  if (quickId === null) {
    return undefined;
  }
  for (const column of SWIMLANE_COLUMNS) {
    const found = band.columns[column].find((n) => n.id === quickId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Whether a band has any card in a swimlane column. The desktop grid renders
 * only the four swimlane columns, so a band whose cards are all held
 * (parked/blocked/awaiting) would draw a phantom empty row — those held nodes
 * already live in the flat HELD ledge. Widening the band bucketing to all seven
 * columns (for the mobile board) must not resurrect such rows on desktop
 * (MMR-224 review), so the swimlane filters to swimlane-bearing bands.
 */
function hasSwimlaneCards(band: Band): boolean {
  return SWIMLANE_COLUMNS.some((column) => band.columns[column].length > 0);
}

/** The desktop swimlane: a column-header row, then one grid row per band. */
function SwimlaneGrid({
  bands,
  spine,
  onOpenNode,
  onQuickOpen,
  onQuickClose,
  quickId,
  offline,
  headerCount,
}: {
  bands: Band[];
  spine: boolean;
  onOpenNode: (id: string) => void;
  onQuickOpen: (id: string) => void;
  onQuickClose: () => void;
  quickId: string | null;
  offline?: boolean;
  headerCount: Record<SwimlaneColumn, number>;
}) {
  const template = gridTemplate(spine);
  return (
    <div>
      <div
        className="grid gap-3 border-b border-line py-2"
        style={{ gridTemplateColumns: template }}
      >
        {spine && <div />}
        {SWIMLANE_COLUMNS.map((column) => (
          <StatusColumnHeader key={column} column={column} count={headerCount[column]} />
        ))}
      </div>
      {bands.length === 0 && (
        <p className="py-6 text-center text-tag text-ink-faint">Nothing on the board yet</p>
      )}
      {bands.map((band, i) => {
        const quickNode = quickNodeInBand(band, quickId);
        return (
          <div
            key={band.key}
            className={cn(
              'grid items-start gap-3 py-3.5',
              i < bands.length - 1 && 'border-b border-line',
            )}
            style={{ gridTemplateColumns: template }}
          >
            {spine && <BandSpine band={band} />}
            {SWIMLANE_COLUMNS.map((column) => (
              <SwimlaneColumnCell
                key={column}
                band={band}
                column={column}
                onQuickOpen={onQuickOpen}
                offline={offline}
                quickId={quickId}
              />
            ))}
            {quickNode !== undefined && (
              // The panel owns its 14px top gap (mt-3.5); `-mt-3` cancels the
              // band grid's own 12px row-gap so the two don't stack to ~26px.
              <div className="-mt-3" style={{ gridColumn: '1 / -1' }}>
                <QuickViewPanel
                  key={quickNode.id}
                  node={quickNode}
                  onClose={onQuickClose}
                  onOpenNode={onOpenNode}
                  offline={offline}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Which status a swipe lands on, or null for a non-swipe (MMR-70). A swipe must
 * be horizontal-dominant and clear the threshold; left (dx<0) advances, right
 * retreats; past either end is a no-op. The mobile board (MMR-224) pages this
 * over the canonical board-status order.
 */
export function swipeTarget(
  current: string,
  dx: number,
  dy: number,
  ids: readonly string[],
): string | null {
  if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy)) {
    return null;
  }
  return ids[ids.indexOf(current) + (dx < 0 ? 1 : -1)] ?? null;
}

/** The board carries card lists for these seven words; `new`/`abandoned` aren't fetched here. */
function isBoardColumn(status: string): status is BoardColumn {
  return (BOARD_COLUMNS as readonly string[]).includes(status);
}

/**
 * The mobile swipe/paging order: the canonical status order (shared by dots,
 * bars, and the sheet) narrowed to the words the board actually fetches. `new`
 * and `abandoned` appear in the sheet as counts but are not board pages (G1).
 */
const BOARD_STATUS_ORDER: readonly BoardColumn[] = STATUS_ORDER.filter(isBoardColumn);

/**
 * One inline band header above a status's card group (MMR-224). A lighter
 * anatomy than the desktop BandSpine: name + (∞ for standing bands) + hairline +
 * this status's count. Purely informational — no collapse affordance.
 */
function MobileBandHeader({
  name,
  openEnded,
  count,
  first,
}: {
  name: string;
  openEnded: boolean;
  count: number;
  first: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2 px-4 pb-2', first ? 'pt-0.5' : 'pt-3.5')}>
      <span className="text-tag font-semibold text-ink-dim">{name}</span>
      {openEnded && <span className="font-mono text-mono-id text-ink-faint">∞</span>}
      <span className="h-px flex-1 bg-line" />
      <span className="font-mono text-mono-id text-ink-faint tabular-nums">{count}</span>
    </div>
  );
}

/**
 * The single status control (mock 9a): a wash pill naming the current status +
 * count that taps open the nine-word sheet, with a right-aligned swipe hint. The
 * pill reuses the canonical wash idiom (statusChipVariants) at its own radius and
 * scale; the caret carries the plain status hue, the label the `-foreground` tone.
 * A 44px min hit target (the mock's tighter pill padded up for touch).
 */
function MobileStatusControl({
  status,
  count,
  open,
  onOpen,
}: {
  status: BoardColumn;
  count: number;
  open: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-4 pt-0.5 pb-3">
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          statusChipVariants({ status }),
          'min-h-11 gap-2 rounded-[11px] px-[15px] py-2.5 text-meta font-bold focus-visible:outline-2 focus-visible:outline-accent',
        )}
      >
        <StatusDot status={status} />
        <span>
          {STATUS_META[status].label} · {count}
        </span>
        <span className={cn('text-micro', STATUS_META[status].text)} aria-hidden>
          ▾
        </span>
      </button>
      <span className="ml-auto text-micro text-ink-ghost" aria-hidden>
        ‹ swipe ›
      </span>
    </div>
  );
}

/** Shared row anatomy: dot + label + count, min 44px tall. */
const SHEET_ROW_BASE =
  'flex min-h-11 items-center gap-2 rounded-[9px] px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent';

/**
 * A `new`/`abandoned` row (G1): the board never fetched their cards, so there's
 * nothing to select into. Rendered as a plain, quieter row — not a disabled
 * button — so the count reads as an honest census figure rather than a dead
 * affordance (MMR-258).
 */
function StatusSheetCensusRow({ status, count }: { status: StatusWord; count: number }) {
  const meta = STATUS_META[status];
  return (
    <div className={cn(SHEET_ROW_BASE, 'opacity-60')}>
      <StatusDot status={status} className="size-1.5" />
      <span className="flex-1 text-xs font-medium text-ink-faint">{meta.label}</span>
      <span className="font-mono text-mono-id tabular-nums text-ink-faint">{count}</span>
    </div>
  );
}

/**
 * One row of the nine-word sheet. The active row carries the wash + ring (G3);
 * the board's seven words select. Done's label carries the 7-day window tag.
 */
function StatusSheetRow({
  status,
  count,
  active,
  onSelect,
}: {
  status: BoardColumn;
  count: number;
  active: boolean;
  onSelect: (status: BoardColumn) => void;
}) {
  const meta = STATUS_META[status];
  const label = status === 'done' ? 'Done · 7d' : meta.label;
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={() => {
        onSelect(status);
      }}
      className={
        active
          ? cn(statusChipVariants({ status }), SHEET_ROW_BASE, 'font-semibold')
          : cn(SHEET_ROW_BASE, 'hover:bg-well-800')
      }
    >
      <StatusDot status={status} className="size-1.5" />
      <span className={cn('flex-1 text-xs', !active && 'font-medium text-ink-dim')}>{label}</span>
      <span
        className={cn('font-mono text-mono-id tabular-nums', active ? meta.text : 'text-ink-faint')}
      >
        {count}
      </span>
    </button>
  );
}

/**
 * The nine-word bottom sheet (mock 9a). A bespoke bottom-anchored dialog (not the
 * shared node drawer, whose `sm:` switch to a right rail would fire mid-range):
 * this stays bottom-anchored up to the `md` swimlane breakpoint. Dismiss on
 * backdrop tap / Esc (Base UI defaults) or a downward swipe.
 */
function StatusSheet({
  open,
  onOpenChange,
  selected,
  statusCount,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: BoardColumn;
  statusCount: (status: StatusWord) => number;
  onSelect: (status: BoardColumn) => void;
}) {
  const swipeStart = useRef<number | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-well-950/70 backdrop-blur-[2px] transition-opacity duration-[180ms] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          aria-describedby={undefined}
          onTouchStart={(e) => {
            swipeStart.current = e.touches[0]?.clientY ?? null;
          }}
          onTouchEnd={(e) => {
            const start = swipeStart.current;
            swipeStart.current = null;
            const end = e.changedTouches[0]?.clientY;
            if (start !== null && end !== undefined && end - start > 60) {
              onOpenChange(false);
            }
          }}
          className="fixed inset-x-0 bottom-0 z-50 rounded-t-[14px] border-t border-line bg-well-900 pb-4 shadow-2xl outline-none transition-transform duration-[180ms] ease-out data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full"
        >
          <Dialog.Title className="sr-only">Select a status</Dialog.Title>
          <div className="mx-auto mt-2.5 mb-2 h-1 w-9 rounded-full bg-line-bright" aria-hidden />
          <div className="grid grid-cols-2 gap-1 px-3 pb-2">
            {STATUS_ORDER.map((status) =>
              isBoardColumn(status) ? (
                <StatusSheetRow
                  key={status}
                  status={status}
                  count={statusCount(status)}
                  active={status === selected}
                  onSelect={(s) => {
                    onSelect(s);
                    onOpenChange(false);
                  }}
                />
              ) : (
                <StatusSheetCensusRow key={status} status={status} count={statusCount(status)} />
              ),
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The shelf's node, looked up across every board column (not just the selected
 * status). A transition that keeps the node on the board — start, submit,
 * return, park, block, even done within the 7-day window — keeps the shelf
 * open and live on the new status: act and see the result. The shelf closes
 * only when the node leaves the board data entirely (transitioned to
 * new/abandoned, done aged out of the window, or gone on refetch).
 */
function boardNode(board: Board, id: string | null): WireNode | undefined {
  if (id === null) {
    return undefined;
  }
  for (const column of BOARD_COLUMNS) {
    const found = board[column].find((n) => n.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * The mobile board body (mock 9a): a single status control + nine-word sheet +
 * swipe paging, replacing the old six-tab switcher. The selected status's cards
 * are grouped by band (the shared buildBands model) under inline band headers;
 * swipe left/right pages across the board-status order; the control opens the
 * sheet. A card tap opens the mobile **shelf** (MMR-223/258) — a local
 * selection, not the `?node=` dossier — whose own Dossier ↗ routes through
 * onOpenNode; changing status (swipe or sheet) closes it. No drag-to-reorder
 * here — the surface is swipe-first.
 */
function MobileBoard({
  bandList,
  board,
  distribution,
  onOpenNode,
  offline,
}: {
  bandList: Band[];
  board: Board;
  distribution?: Distribution;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  // Open on the first populated status in canonical order rather than a fixed
  // `in_progress`, so a project with no in-progress work doesn't land on an empty
  // board (MMR-224 review); an all-empty board falls back to `in_progress` copy.
  const [selected, setSelected] = useState<BoardColumn>(
    () => BOARD_STATUS_ORDER.find((column) => board[column].length > 0) ?? 'in_progress',
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  // The open shelf (MMR-258) — a local selection mirroring the desktop `quickId`
  // idiom, deliberately not the `?node=` dossier address (see BoardView).
  const [shelfId, setShelfId] = useState<string | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const statusCount = (status: StatusWord): number =>
    isBoardColumn(status) ? board[status].length : (distribution?.[status] ?? 0);

  const bandsForStatus = bandList.filter((band) => band.columns[selected].length > 0);
  const shelfNode = boardNode(board, shelfId);

  // Changing the visible status page — by swipe or by the sheet — retires the
  // shelf rather than leaving it pointing at a card that's no longer on screen.
  function changeStatus(status: BoardColumn) {
    setSelected(status);
    setShelfId(null);
  }

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    touchStart.current = t === undefined ? null : { x: t.clientX, y: t.clientY };
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    const t = e.changedTouches[0];
    if (start === null || t === undefined) {
      return;
    }
    const target = swipeTarget(
      selected,
      t.clientX - start.x,
      t.clientY - start.y,
      BOARD_STATUS_ORDER,
    );
    if (target !== null && isBoardColumn(target)) {
      changeStatus(target);
    }
  }

  return (
    <div className="pb-4 md:hidden" data-testid="mobile-board">
      <MobileStatusControl
        status={selected}
        count={board[selected].length}
        open={sheetOpen}
        onOpen={() => {
          setSheetOpen(true);
        }}
      />
      <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {bandsForStatus.length === 0 ? (
          <p className="px-4 py-6 text-center text-tag text-ink-faint">
            Nothing {STATUS_META[selected].label.toLowerCase()}
          </p>
        ) : (
          bandsForStatus.map((band, i) => (
            <section
              key={band.key}
              aria-label={band.name === '' ? STATUS_META[selected].label : band.name}
            >
              {band.name !== '' && (
                <MobileBandHeader
                  name={band.name}
                  openEnded={band.openEnded}
                  count={band.columns[selected].length}
                  first={i === 0}
                />
              )}
              <ol className="flex flex-col gap-2 px-4">
                {band.columns[selected].map((node) => (
                  <li key={node.id}>
                    <BoardCard
                      node={node}
                      column={selected}
                      onOpen={setShelfId}
                      offline={offline}
                      mobile
                    />
                  </li>
                ))}
              </ol>
            </section>
          ))
        )}
        {shelfNode !== undefined && (
          <QuickShelf
            key={shelfNode.id}
            node={shelfNode}
            onClose={() => {
              setShelfId(null);
            }}
            onOpenNode={onOpenNode}
            offline={offline}
          />
        )}
      </div>
      <StatusSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        selected={selected}
        statusCount={statusCount}
        onSelect={changeStatus}
      />
    </div>
  );
}

/**
 * The board — the status lens. Drag-to-reorder (rankable columns, grip handle
 * only) runs `reorder`; all status changes are explicit (card kebab). One
 * DndContext spans the board; a drop resolves within its source column.
 */
export function BoardView({
  board,
  bands,
  tree,
  onOpenNode,
  offline,
  distribution,
  doneTotal,
  onViewDone,
}: BoardViewProps) {
  const sensors = useSensors(useSensor(PointerSensor), useSensor(TouchSensor));
  const reorder = useReorder();

  const bandList = buildBands(board, bands, tree);
  // The desktop swimlane renders only the four swimlane columns; drop bands whose
  // cards are entirely held so widened bucketing (MMR-224) draws no phantom rows.
  const swimlaneBands = bandList.filter(hasSwimlaneCards);
  // Off mode has no spine; phase mode without a tree degrades to the same flat,
  // spineless grid rather than rendering a nameless 170px spine gutter (§4).
  const spine = bands !== 'off' && !(bands === 'phase' && tree === undefined);
  const headerCount: Record<SwimlaneColumn, number> = {
    done: board.done.length,
    in_progress: board.in_progress.length,
    ready: board.ready.length,
    under_review: board.under_review.length,
  };

  // The open quick view (MMR-223) — a single in-surface selection, not the
  // `?node=` dossier address. Desktop renders it as a drop panel below the
  // card's band row via this quickId; mobile owns an equivalent local shelfId
  // inside MobileBoard (MMR-258) — the two surfaces never share selection.
  const [quickId, setQuickId] = useState<string | null>(null);
  const closeQuick = () => {
    setQuickId(null);
  };

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over === null || active.id === over.id) {
      return;
    }
    const activeId = String(active.id);
    const overId = String(over.id);
    for (const column of RANKABLE_COLUMNS) {
      const ids = columnIds(board, column);
      if (ids.includes(activeId) && ids.includes(overId)) {
        const args = dropToReorder(activeId, overId, ids);
        if (args !== null) {
          reorder.mutate({ id: activeId, ...args });
        }
        return;
      }
    }
  }

  // The desktop swimlane owns the only DndContext: it's the sole surface with
  // drag-to-reorder. The mobile board is swipe-first (no sortable cards), so it
  // needs no context — and with no shared sortable ids, the old collision
  // between two permanently-mounted surfaces is gone (MMR-224).
  return (
    <div data-testid="board">
      {/* desktop — the swimlane grid: HELD ledge, band × status columns, Done drill-through */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div data-testid="swimlane" className="hidden px-5 md:block">
          <HeldLedge board={board} />
          <SwimlaneGrid
            bands={swimlaneBands}
            spine={spine}
            onOpenNode={onOpenNode}
            onQuickOpen={setQuickId}
            onQuickClose={closeQuick}
            quickId={quickId}
            offline={offline}
            headerCount={headerCount}
          />
          <SwimlaneDoneFooter
            shown={board.done.length}
            total={doneTotal}
            onViewDone={onViewDone}
            spine={spine}
          />
        </div>
      </DndContext>

      {/* mobile — single status control + nine-word sheet + swipe paging (mock 9a) */}
      <MobileBoard
        bandList={bandList}
        board={board}
        distribution={distribution}
        onOpenNode={onOpenNode}
        offline={offline}
      />
    </div>
  );
}
