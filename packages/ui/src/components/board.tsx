import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRef, useState } from "react";
import { cn } from "../lib/cn";
import { BOARD_COLUMNS, isCollapsible, type Board, type BoardColumn } from "../lib/board";
import { reorderArgs, type ReorderArgs } from "../lib/reorder";
import { STATUS_META } from "../lib/status";
import { useReorder } from "../api/mutations";
import type { WireNode } from "../api/types";
import { NodeCard } from "./node-card";
import { StatusDot } from "./status-dot";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "./ui/menu";
import { Tabs, TabsContent } from "./ui/tabs";

interface BoardViewProps {
  board: Board;
  onOpenNode: (id: string) => void;
  offline?: boolean;
  /** node id → `initiative › phase` breadcrumb, for the card's tree context. */
  ancestry?: Map<string, string>;
  /** Total completed tasks fetched (before the Done window) — the `m` in "n of m". */
  doneTotal: number;
  /** Drill from Done into the `/tasks` browser (kept a callback so the board stays router-free). */
  onViewDone: () => void;
}

/** The rankable set (ADR 0007) as board columns — drag-to-reorder lives here only. */
export const RANKABLE_COLUMNS = ["in_progress", "ready", "awaiting"] as const;
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
      <h2 className={cn("microlabel", meta.text)}>{meta.label}</h2>
      <span className="ml-auto font-mono text-[0.625rem] text-ink-dim">{count}</span>
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

/** A non-actionable column folded to a narrow count strip (MMR-76); click expands. */
function CollapsedColumn({
  column,
  count,
  onExpand,
}: {
  column: BoardColumn;
  count: number;
  onExpand: () => void;
}) {
  const meta = STATUS_META[column];
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Expand ${meta.label} (${count})`}
      className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-md border border-line bg-well-900/40 py-2 transition-colors hover:border-line-bright hover:bg-well-900/70 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <StatusDot status={column} />
      <span className="font-mono text-[0.6875rem] font-semibold text-ink-dim tabular-nums">
        {count}
      </span>
      <span className={cn("microlabel [writing-mode:vertical-rl] rotate-180", meta.text)}>
        {meta.label}
      </span>
    </button>
  );
}

/** Done's drill-through: the window shows recent completions; the rest is in `/tasks`. */
function DoneFooter({
  shown,
  total,
  onViewDone,
}: {
  shown: number;
  total: number;
  onViewDone: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onViewDone}
      className="border-t border-line px-2 py-1.5 text-left text-[0.625rem] text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
    >
      {total > shown ? `${shown} of ${total} recent · all →` : `${total} done · view all →`}
    </button>
  );
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
    id: node.id,
    disabled: offline,
  });
  return (
    <NodeCard
      node={node}
      onOpen={onOpenNode}
      offline={offline}
      ancestry={ancestry}
      sortable={{
        setNodeRef,
        handleProps: { ...attributes, ...listeners },
        style: { transform: CSS.Transform.toString(transform), transition },
        isDragging,
      }}
    />
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
    return <p className="px-2 py-3 text-center text-[0.6875rem] text-ink-faint">—</p>;
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
  { id: "held", label: "Held", columns: ["parked", "blocked"] },
  { id: "awaiting", label: "Await", columns: ["awaiting"] },
  { id: "ready", label: "Ready", columns: ["ready"] },
  { id: "in_progress", label: "In prog", columns: ["in_progress"] },
  { id: "under_review", label: "Review", columns: ["under_review"] },
  { id: "done", label: "Done", columns: ["done"] },
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
  if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy)) return null;
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
  if (active === undefined) return null;
  const activeDot = active.columns.length === 1 ? active.columns[0] : undefined;
  return (
    <MenuRoot>
      <MenuTrigger className="flex w-full items-center justify-between rounded-md border border-line bg-well-850 px-3 py-2 text-[0.875rem] font-semibold text-ink-bright transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent">
        <span className="flex items-center gap-2">
          {activeDot !== undefined && <StatusDot status={activeDot} />}
          {active.label}
          <span className="font-mono text-[0.75rem] font-normal text-ink-dim tabular-nums">
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
              className={cn("gap-2", isCurrent && "bg-well-800")}
              onClick={() => {
                onSelect(tab.id);
              }}
            >
              {dot !== undefined && <StatusDot status={dot} />}
              <span
                className={cn(
                  "text-[0.875rem]",
                  isCurrent ? "font-semibold text-ink-bright" : "text-ink",
                )}
              >
                {tab.label}
              </span>
              <span className="ml-auto font-mono text-[0.8125rem] text-ink-dim tabular-nums">
                {tabCount(tab)}
              </span>
              {isCurrent && <span className="text-accent">✓</span>}
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
  onOpenNode,
  offline,
  ancestry,
  doneTotal,
  onViewDone,
}: BoardViewProps) {
  const sensors = useSensors(useSensor(PointerSensor), useSensor(TouchSensor));
  const reorder = useReorder();
  // Which collapsed (non-actionable) columns the operator has expanded inline.
  const [expanded, setExpanded] = useState<ReadonlySet<BoardColumn>>(new Set());
  const toggle = (column: BoardColumn) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });

  // Mobile: swipe left/right to move between the column tabs (MMR-70).
  const [mobileTab, setMobileTab] = useState<string>("in_progress");
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    touchStart.current = t === undefined ? null : { x: t.clientX, y: t.clientY };
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    const t = e.changedTouches[0];
    if (start === null || t === undefined) return;
    const target = swipeTarget(
      mobileTab,
      t.clientX - start.x,
      t.clientY - start.y,
      MOBILE_TABS.map((tab): string => tab.id),
    );
    if (target !== null) setMobileTab(target);
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
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

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div data-testid="board">
        {/* desktop — three tiers: full actionable columns, windowed Done, collapsed strips */}
        <div className="hidden min-h-0 gap-1.5 md:flex">
          {BOARD_COLUMNS.map((column) => {
            const count = board[column].length;
            if (isCollapsible(column) && !expanded.has(column)) {
              return (
                <CollapsedColumn
                  key={column}
                  column={column}
                  count={count}
                  onExpand={() => {
                    toggle(column);
                  }}
                />
              );
            }
            return (
              <section
                key={column}
                aria-label={STATUS_META[column].label}
                className="flex min-w-0 flex-1 flex-col rounded-md border border-line bg-well-900/60"
              >
                <ColumnHeader
                  column={column}
                  count={count}
                  onCollapse={
                    isCollapsible(column)
                      ? () => {
                          toggle(column);
                        }
                      : undefined
                  }
                />
                <ColumnCards
                  board={board}
                  column={column}
                  onOpenNode={onOpenNode}
                  offline={offline}
                  ancestry={ancestry}
                />
                {column === "done" && (
                  <DoneFooter shown={count} total={doneTotal} onViewDone={onViewDone} />
                )}
              </section>
            );
          })}
        </div>

        {/* mobile — a column-header dropdown switcher (MMR-86) + swipe (MMR-70) */}
        <div className="md:hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
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
      </div>
    </DndContext>
  );
}
