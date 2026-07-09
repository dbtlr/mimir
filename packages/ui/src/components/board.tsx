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
import { useRef, useState } from 'react';

import { useReorder } from '../api/mutations';
import type { WireNode, WireTreeNode } from '../api/types';
import { SWIMLANE_COLUMNS, SWIMLANE_RANKABLE, buildBands } from '../lib/bands';
import type { Band, BandMode, SwimlaneColumn } from '../lib/bands';
import type { Board, BoardColumn } from '../lib/board';
import { cn } from '../lib/cn';
import { reorderArgs } from '../lib/reorder';
import type { ReorderArgs } from '../lib/reorder';
import { STATUS_META } from '../lib/status';
import { BoardCard } from './board-card';
import { DistributionBar } from './distribution-bar';
import { NodeCard } from './node-card';
import { StatusDot } from './status-dot';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from './ui/menu';
import { Tabs, TabsContent } from './ui/tabs';

type BoardViewProps = {
  board: Board;
  /** The swimlane grouping (`?bands=`); `off` drops the spine to a flat grid. */
  bands: BandMode;
  /** The whole-project tree — feeds phase-mode ancestry; absent degrades to flat. */
  tree?: WireTreeNode;
  onOpenNode: (id: string) => void;
  offline?: boolean;
  /** node id → `initiative › phase` breadcrumb, for the mobile card's tree context. */
  ancestry?: Map<string, string>;
  /** Total completed tasks fetched (before the Done window) — the `m` in "n of m". */
  doneTotal: number;
  /** Drill from Done into the `/tasks` browser (kept a callback so the board stays router-free). */
  onViewDone: () => void;
};

/** The rankable set (ADR 0007) as board columns — drag-to-reorder lives here only. */
export const RANKABLE_COLUMNS = ['in_progress', 'ready', 'awaiting'] as const;
type RankableColumn = (typeof RANKABLE_COLUMNS)[number];

function isRankable(column: BoardColumn): column is RankableColumn {
  return (RANKABLE_COLUMNS as readonly string[]).includes(column);
}

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

function ColumnHeader({
  column,
  count,
  onCollapse,
}: {
  column: BoardColumn;
  count: number;
  onCollapse?: () => void;
}) {
  const meta = STATUS_META[column];
  return (
    <header className="flex items-center gap-2 border-b border-line px-2 py-1.5">
      <StatusDot status={column} />
      <h2 className={cn('microlabel', meta.text)}>{meta.label}</h2>
      <span className="ml-auto font-mono text-micro text-ink-dim">{count}</span>
      {onCollapse !== undefined && (
        <button
          type="button"
          onClick={onCollapse}
          aria-label={`Collapse ${meta.label}`}
          className="rounded text-ink-faint transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m15 18-6-6 6-6"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </header>
  );
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

/** A draggable card: useSortable feeds the grip + ref into NodeCard. */
function SortableCard({
  node,
  onOpenNode,
  offline,
  ancestry,
}: {
  node: WireNode;
  onOpenNode: (id: string) => void;
  offline?: boolean;
  ancestry?: string;
}) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    disabled: offline,
    id: node.id,
  });
  return (
    <NodeCard
      node={node}
      onOpen={onOpenNode}
      offline={offline}
      ancestry={ancestry}
      sortable={{
        handleProps: { ...attributes, ...listeners },
        isDragging,
        setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
      }}
    />
  );
}

/** The swimlane draggable: useSortable feeds the grip + ref into BoardCard. */
function SortableBoardCard({
  node,
  column,
  onOpenNode,
  offline,
}: {
  node: WireNode;
  column: SwimlaneColumn;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    disabled: offline,
    id: node.id,
  });
  return (
    <BoardCard
      node={node}
      column={column}
      onOpen={onOpenNode}
      offline={offline}
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
  onOpenNode,
  offline,
}: {
  band: Band;
  column: SwimlaneColumn;
  onOpenNode: (id: string) => void;
  offline?: boolean;
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
              onOpenNode={onOpenNode}
              offline={offline}
            />
          ) : (
            <BoardCard node={node} column={column} onOpen={onOpenNode} offline={offline} />
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

/** The desktop swimlane: a column-header row, then one grid row per band. */
function SwimlaneGrid({
  bands,
  spine,
  onOpenNode,
  offline,
  headerCount,
}: {
  bands: Band[];
  spine: boolean;
  onOpenNode: (id: string) => void;
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
      {bands.map((band, i) => (
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
              onOpenNode={onOpenNode}
              offline={offline}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ColumnCards({
  board,
  column,
  onOpenNode,
  offline,
  ancestry,
}: {
  board: Board;
  column: BoardColumn;
  onOpenNode: (id: string) => void;
  offline?: boolean;
  ancestry?: Map<string, string>;
}) {
  const items = board[column];
  if (items.length === 0) {
    return (
      <p className="px-2 py-4 text-center text-tag text-ink-faint">
        Nothing {STATUS_META[column].label.toLowerCase()}
      </p>
    );
  }
  const rankable = isRankable(column);
  const list = (
    <ol className="flex flex-col gap-1.5 py-1.5 md:p-1.5">
      {items.map((node) => (
        <li key={node.id}>
          {rankable ? (
            <SortableCard
              node={node}
              onOpenNode={onOpenNode}
              offline={offline}
              ancestry={ancestry?.get(node.id)}
            />
          ) : (
            <NodeCard
              node={node}
              onOpen={onOpenNode}
              offline={offline}
              ancestry={ancestry?.get(node.id)}
            />
          )}
        </li>
      ))}
    </ol>
  );
  return rankable ? (
    <SortableContext items={columnIds(board, column)} strategy={verticalListSortingStrategy}>
      {list}
    </SortableContext>
  ) : (
    list
  );
}

const MOBILE_TABS = [
  { columns: ['parked', 'blocked'], id: 'held', label: 'Held' },
  { columns: ['awaiting'], id: 'awaiting', label: 'Awaiting' },
  { columns: ['ready'], id: 'ready', label: 'Ready' },
  { columns: ['in_progress'], id: 'in_progress', label: 'In progress' },
  { columns: ['under_review'], id: 'under_review', label: 'Under review' },
  { columns: ['done'], id: 'done', label: 'Done' },
] as const satisfies readonly { id: string; label: string; columns: readonly BoardColumn[] }[];

/**
 * Which mobile tab a swipe lands on, or null for a non-swipe (MMR-70). A swipe
 * must be horizontal-dominant and clear the threshold; left (dx<0) advances,
 * right retreats; past either end is a no-op.
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

/**
 * The mobile column switcher (MMR-86): the current column IS a big legible
 * header that taps open to a jump menu of every column + count — replacing the
 * crammed tab row, which couldn't show the active column and got worse as the
 * vocabulary grew. Swipe (MMR-70) still moves between columns.
 */
function MobileColumnSwitcher({
  current,
  board,
  onSelect,
}: {
  current: string;
  board: Board;
  onSelect: (id: string) => void;
}) {
  const tabCount = (tab: (typeof MOBILE_TABS)[number]): number =>
    tab.columns.reduce((n, c) => n + board[c].length, 0);
  const active = MOBILE_TABS.find((t) => t.id === current);
  if (active === undefined) {
    return null;
  }
  const activeDot = active.columns.length === 1 ? active.columns[0] : undefined;
  // The signature control carries the active column's status color on its left edge (like the cards).
  const accent = activeDot !== undefined ? STATUS_META[activeDot].border : 'border-l-line';
  return (
    <MenuRoot>
      <MenuTrigger
        className={cn(
          'flex w-full items-center justify-between rounded-md border border-l-2 border-line bg-well-850 px-3 py-2 text-sm font-semibold text-ink-bright transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent',
          accent,
        )}
      >
        <span className="flex items-center gap-2">
          {activeDot !== undefined && <StatusDot status={activeDot} />}
          {active.label}
          <span className="font-mono text-xs font-normal text-ink-dim tabular-nums">
            {tabCount(active)}
          </span>
        </span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="m6 9 6 6 6-6"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </MenuTrigger>
      <MenuContent className="w-[calc(100vw-2rem)] max-w-sm">
        {MOBILE_TABS.map((tab) => {
          const dot = tab.columns.length === 1 ? tab.columns[0] : undefined;
          const isCurrent = tab.id === current;
          return (
            <MenuItem
              key={tab.id}
              className={cn('min-h-11 gap-2 py-2.5', isCurrent && 'bg-well-800')}
              onClick={() => {
                onSelect(tab.id);
              }}
            >
              {dot !== undefined && <StatusDot status={dot} />}
              <span
                className={cn('text-sm', isCurrent ? 'font-semibold text-ink-bright' : 'text-ink')}
              >
                {tab.label}
              </span>
              {/* right cluster: check sits LEFT of the count, so the count's right edge is constant across rows */}
              <span className="ml-auto flex items-center gap-2">
                {isCurrent && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                    className="text-accent"
                  >
                    <path
                      d="m5 13 4 4L19 7"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                <span className="font-mono text-sm text-ink-dim tabular-nums">{tabCount(tab)}</span>
              </span>
            </MenuItem>
          );
        })}
      </MenuContent>
    </MenuRoot>
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
  ancestry,
  doneTotal,
  onViewDone,
}: BoardViewProps) {
  const sensors = useSensors(useSensor(PointerSensor), useSensor(TouchSensor));
  const reorder = useReorder();

  const bandList = buildBands(board, bands, tree);
  // Off mode has no spine; phase mode without a tree degrades to the same flat,
  // spineless grid rather than rendering a nameless 170px spine gutter (§4).
  const spine = bands !== 'off' && !(bands === 'phase' && tree === undefined);
  const headerCount: Record<SwimlaneColumn, number> = {
    done: board.done.length,
    in_progress: board.in_progress.length,
    ready: board.ready.length,
    under_review: board.under_review.length,
  };

  // Mobile: swipe left/right to move between the column tabs (MMR-70).
  const [mobileTab, setMobileTab] = useState<string>('in_progress');
  const touchStart = useRef<{ x: number; y: number } | null>(null);
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
      mobileTab,
      t.clientX - start.x,
      t.clientY - start.y,
      MOBILE_TABS.map((tab): string => tab.id),
    );
    if (target !== null) {
      setMobileTab(target);
    }
  }

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

  // The desktop swimlane and mobile board are both permanently mounted (md:
  // toggles visibility, not rendering), so a rankable card registers useSortable
  // under the same id in both. One DndContext spanning both would collide those
  // ids in its registry; give each surface its own context (drop resolution is
  // otherwise identical) so the hidden twin never captures a drop.
  return (
    <div data-testid="board">
      {/* desktop — the swimlane grid: HELD ledge, band × status columns, Done drill-through */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div data-testid="swimlane" className="hidden px-5 md:block">
          <HeldLedge board={board} />
          <SwimlaneGrid
            bands={bandList}
            spine={spine}
            onOpenNode={onOpenNode}
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

      {/* mobile — a column-header dropdown switcher (MMR-86) + swipe (MMR-70) */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="px-4 pb-4 md:hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <Tabs
            className="w-full"
            value={mobileTab}
            onValueChange={(v) => {
              setMobileTab(String(v));
            }}
          >
            <MobileColumnSwitcher current={mobileTab} board={board} onSelect={setMobileTab} />
            {MOBILE_TABS.map((tab) => (
              <TabsContent key={tab.id} value={tab.id} className="mt-2 w-full">
                {tab.columns.map((column) => (
                  <section key={column} aria-label={STATUS_META[column].label}>
                    {tab.columns.length > 1 && (
                      <ColumnHeader column={column} count={board[column].length} />
                    )}
                    <ColumnCards
                      board={board}
                      column={column}
                      onOpenNode={onOpenNode}
                      offline={offline}
                      ancestry={ancestry}
                    />
                  </section>
                ))}
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </DndContext>
    </div>
  );
}
