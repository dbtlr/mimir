import { formatNodeJson } from "../core";
import type { NodeView, SetResult, StatusView } from "../contract/dto";
import type { StateWord } from "../contract/enums";

export const FORMATS = ["table", "records", "ids", "json", "jsonl"] as const;
export type Format = (typeof FORMATS)[number];

/**
 * The styled TTY formats — `table` (set view) and `records` (detail view).
 * Color/icon only *highlight*; the State **word** is always present, so
 * `--ascii` / NO_COLOR lose nothing (output-contract / Norn's "color is
 * decoration, never information"). Glyphs + palette are provisional — the brand
 * pass is deferred.
 */

/** Output sink + presentation context, injected so the CLI is testable. */
export interface Io {
  write: (text: string) => void;
  error: (text: string) => void;
  /** Is stdout a TTY? Drives the format default. */
  isTTY: boolean;
  /** Suppress ANSI (NO_COLOR env or `--ascii`). */
  plain: boolean;
}

interface StateStyle {
  icon: string;
  ascii: string;
  color: number;
}

const STATE_STYLE: Record<StateWord, StateStyle> = {
  ready: { icon: "●", ascii: "*", color: 32 },
  awaiting: { icon: "◔", ascii: "~", color: 33 },
  in_progress: { icon: "▶", ascii: ">", color: 36 },
  blocked: { icon: "■", ascii: "x", color: 31 },
  parked: { icon: "⏸", ascii: "=", color: 90 },
  done: { icon: "✓", ascii: "v", color: 32 },
  abandoned: { icon: "✗", ascii: "X", color: 90 },
  new: { icon: "○", ascii: "o", color: 90 },
};

function color(text: string, code: number, plain: boolean): string {
  return plain ? text : `\x1b[${String(code)}m${text}\x1b[0m`;
}

function bold(text: string, plain: boolean): string {
  return plain ? text : `\x1b[1m${text}\x1b[0m`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** `${n} task` / `${n} tasks` — the count line that leads every set view. */
export function countLine(n: number, unit = "task"): string {
  return `${String(n)} ${unit}${n === 1 ? "" : "s"}`;
}

function stateCell(state: StateWord, width: number, plain: boolean): string {
  const style = STATE_STYLE[state];
  const glyph = plain ? style.ascii : style.icon;
  return color(`${glyph} ${pad(state, width)}`, style.color, plain);
}

/** `table` — one task per line, count-led, in array (rank) order. */
export function renderTable(result: SetResult<NodeView>, io: Io): string {
  const lines = [countLine(result.total)];
  const items = result.items;
  if (items.length === 0) {
    return lines.join("\n");
  }
  lines.push("");
  const idW = Math.max(...items.map((n) => n.id.length));
  const stW = Math.max(...items.map((n) => n.state.length));
  for (const n of items) {
    const priority = n.priority ?? "";
    lines.push(
      `${pad(n.id, idW)}   ${stateCell(n.state, stW, io.plain)}   ${pad(priority, 2)}   ${n.title}`,
    );
  }
  return lines.join("\n");
}

function row(label: string, value: string, labelW: number): string {
  return `  ${pad(label, labelW)}  ${value}`;
}

/** `records` — bold id header + aligned `label  value` rows, bare fields then facets. */
export function renderRecords(node: NodeView, io: Io): string {
  const lines = [bold(node.id, io.plain)];
  const pairs: [string, string][] = [
    ["type", node.type],
    ["state", stateCell(node.state, node.state.length, io.plain)],
    ["title", node.title],
  ];
  if (node.parent !== null) pairs.push(["parent", node.parent]);
  if (node.description != null) pairs.push(["description", node.description]);
  if (node.priority != null) pairs.push(["priority", node.priority]);
  if (node.size != null) pairs.push(["size", node.size]);
  if (node.lifecycle !== undefined) pairs.push(["lifecycle", node.lifecycle]);
  if (node.hold !== undefined) pairs.push(["hold", node.hold]);
  if (node.holdReason != null) pairs.push(["hold reason", node.holdReason]);
  if (node.target != null) pairs.push(["target", node.target]);
  if (node.externalRef != null) pairs.push(["external ref", node.externalRef]);
  if (node.completedAt != null) pairs.push(["completed", node.completedAt]);

  if (node.deps !== undefined && node.deps.dependsOn.length > 0) {
    pairs.push(["depends on", node.deps.dependsOn.map((r) => r.id).join(", ")]);
  }
  if (node.deps !== undefined && node.deps.blocking.length > 0) {
    pairs.push(["blocking", node.deps.blocking.map((r) => r.id).join(", ")]);
  }
  if (node.children !== undefined && node.children.length > 0) {
    pairs.push(["children", node.children.map((r) => `${r.id} (${r.state ?? "?"})`).join(", ")]);
  }
  if (node.distribution !== undefined && Object.keys(node.distribution).length > 0) {
    const dist = Object.entries(node.distribution)
      .map(([word, count]) => `${word}:${String(count)}`)
      .join(", ");
    pairs.push(["distribution", dist]);
  }
  if (node.tags !== undefined && node.tags.length > 0) {
    pairs.push(["tags", node.tags.map((t) => t.tag).join(", ")]);
  }
  if (node.annotations !== undefined && node.annotations.length > 0) {
    pairs.push(["annotations", String(node.annotations.length)]);
  }
  if (node.artifacts !== undefined && node.artifacts.length > 0) {
    pairs.push(["artifacts", String(node.artifacts.length)]);
  }
  if (node.history !== undefined && node.history.length > 0) {
    pairs.push([
      "history",
      node.history.map((h) => `${h.kind} ${h.from ?? "-"}→${h.to ?? "-"}`).join("; "),
    ]);
  }

  const labelW = Math.max(...pairs.map(([label]) => label.length));
  for (const [label, value] of pairs) {
    lines.push(row(label, value, labelW));
  }
  return lines.join("\n");
}

/**
 * Render a single node to `io` in the given format. Exhaustive over all five
 * `Format` values — TypeScript enforces no gaps. No `default` branch so the
 * compiler catches any missing case (no import from `./errors` to avoid the
 * render↔errors import cycle).
 */
export function renderNodeView(view: NodeView, format: Format, io: Io): void {
  switch (format) {
    case "json":
    case "jsonl":
      io.write(formatNodeJson(view));
      break;
    case "ids":
      io.write(view.id);
      break;
    case "table":
      io.write(renderTable({ total: 1, returned: 1, startsAt: 0, items: [view] }, io));
      break;
    case "records":
      io.write(renderRecords(view, io));
      break;
  }
}

/** `records`-style rendering of `status_of` — label + distribution. */
export function renderStatus(status: StatusView, io: Io): string {
  const dist = Object.entries(status.distribution)
    .map(([word, count]) => `${word}:${String(count)}`)
    .join(", ");
  const lines = [
    bold(status.id, io.plain),
    row("state", stateCell(status.state, status.state.length, io.plain), 12),
    row("distribution", dist === "" ? "(none)" : dist, 12),
  ];
  return lines.join("\n");
}
