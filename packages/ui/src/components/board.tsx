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
import { cn } from "../lib/cn";
import { BOARD_COLUMNS, type Board, type BoardColumn } from "../lib/board";
import { reorderArgs, type ReorderArgs } from "../lib/reorder";
import { STATUS_META } from "../lib/status";
import { useReorder } from "../api/mutations";
import type { WireNode } from "../api/types";
import { NodeCard } from "./node-card";
import { StatusDot } from "./status-dot";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface BoardViewProps {
  board: Board;
  onOpenNode: (id: string) => void;
  offline?: boolean;
  /** node id → `initiative › phase` breadcrumb, for the card's tree context. */
  ancestry?: Map<string, string>;
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

function ColumnHeader({ column, count }: { column: BoardColumn; count: number }) {
  const meta = STATUS_META[column];
  return (
    <header className="flex items-center gap-2 border-b border-line px-2 py-1.5">
      <StatusDot status={column} />
      <h2 className={cn("microlabel", meta.text)}>{meta.label}</h2>
      <span className="ml-auto font-mono text-[10px] text-ink-dim">{count}</span>
    </header>
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
    return <p className="px-2 py-3 text-center text-[11px] text-ink-faint">—</p>;
  }
  const rankable = isRankable(column);
  const list = (
    <ol className="flex flex-col gap-1.5 p-1.5">
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
  { id: "done", label: "Done", columns: ["done"] },
] as const satisfies readonly { id: string; label: string; columns: readonly BoardColumn[] }[];

/**
 * The board — the status lens. Drag-to-reorder (rankable columns, grip handle
 * only) runs `reorder`; all status changes are explicit (card kebab). One
 * DndContext spans the board; a drop resolves within its source column.
 */
export function BoardView({ board, onOpenNode, offline, ancestry }: BoardViewProps) {
  const sensors = useSensors(useSensor(PointerSensor), useSensor(TouchSensor));
  const reorder = useReorder();

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
        {/* desktop */}
        <div className="hidden min-h-0 grid-cols-6 gap-1.5 md:grid">
          {BOARD_COLUMNS.map((column) => (
            <section
              key={column}
              aria-label={STATUS_META[column].label}
              className="flex min-w-0 flex-col rounded-md border border-line bg-well-900/60"
            >
              <ColumnHeader column={column} count={board[column].length} />
              <ColumnCards
                board={board}
                column={column}
                onOpenNode={onOpenNode}
                offline={offline}
                ancestry={ancestry}
              />
            </section>
          ))}
        </div>

        {/* mobile */}
        <div className="md:hidden">
          <Tabs defaultValue="in_progress">
            <TabsList>
              {MOBILE_TABS.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                  <span className="font-mono text-[9px] opacity-70">
                    {tab.columns.reduce((n, c) => n + board[c].length, 0)}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
            {MOBILE_TABS.map((tab) => (
              <TabsContent key={tab.id} value={tab.id} className="mt-2">
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
