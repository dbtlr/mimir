import type { WireNode } from "../api/types";

/**
 * The board's column model — the status lens (ADR 0013 §4). Columns ARE the
 * status vocabulary; `abandoned` is never a column; priority is never a
 * column (ADR 0007). Array order within a column is preserved from the API —
 * that order IS rank for Ready, and completion recency for Done.
 */
export const BOARD_COLUMNS = [
  "parked",
  "blocked",
  "awaiting",
  "ready",
  "in_progress",
  "done",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export type Board = Record<BoardColumn, WireNode[]>;

/** Done stays a recency window, not an archive: the last 7 days of completions. */
export const DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bucket the two board reads into columns. `live` arrives in rank order and
 * is filtered stably, so Ready keeps the queue order; `done` arrives newest
 * completion first and is windowed to {@link DONE_WINDOW_MS}.
 */
export function buildBoard(live: WireNode[], done: WireNode[], now = Date.now()): Board {
  const board: Board = {
    parked: [],
    blocked: [],
    awaiting: [],
    ready: [],
    in_progress: [],
    done: [],
  };
  for (const node of live) {
    if (node.status !== "done" && node.status in board) {
      board[node.status as BoardColumn].push(node);
    }
  }
  board.done = done.filter((node) => {
    const at = node.completed_at;
    return at !== null && at !== undefined && now - Date.parse(at) <= DONE_WINDOW_MS;
  });
  return board;
}
