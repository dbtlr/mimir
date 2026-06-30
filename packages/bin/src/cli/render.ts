import type {
  ArtifactDetail,
  NodeView,
  SetResult,
  StatusView,
  StatusWord,
  TreeView,
} from '@mimir/contract';

import { formatArtifactJson, formatNodeJson } from '../core';

export const FORMATS = ['table', 'records', 'ids', 'json', 'jsonl'] as const;
export type Format = (typeof FORMATS)[number];

/**
 * The styled TTY formats — `table` (set view) and `records` (detail view).
 * Color/icon only *highlight*; the Status **word** is always present, so
 * `--ascii` / NO_COLOR lose nothing (output-contract / Norn's "color is
 * decoration, never information"). Glyphs + palette are provisional — the brand
 * pass is deferred.
 */

/** Output sink + presentation context, injected so the CLI is testable. */
export type Io = {
  write: (text: string) => void;
  error: (text: string) => void;
  /** Is stdout a TTY? Drives the format default. */
  isTTY: boolean;
  /** Suppress ANSI (NO_COLOR env or `--ascii`). */
  plain: boolean;
};

type StatusStyle = {
  icon: string;
  ascii: string;
  color: number;
};

const STATUS_STYLE: Record<StatusWord, StatusStyle> = {
  abandoned: { ascii: 'X', color: 90, icon: '✗' },
  awaiting: { ascii: '~', color: 33, icon: '◔' },
  blocked: { ascii: 'x', color: 31, icon: '■' },
  done: { ascii: 'v', color: 32, icon: '✓' },
  in_progress: { ascii: '>', color: 36, icon: '▶' },
  new: { ascii: 'o', color: 90, icon: '○' },
  parked: { ascii: '=', color: 90, icon: '⏸' },
  ready: { ascii: '*', color: 32, icon: '●' },
  under_review: { ascii: '?', color: 35, icon: '◎' },
};

function color(text: string, code: number, plain: boolean): string {
  return plain ? text : `\x1b[${String(code)}m${text}\x1b[0m`;
}

function bold(text: string, plain: boolean): string {
  return plain ? text : `\x1b[1m${text}\x1b[0m`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** `${n} task` / `${n} tasks` — the count line that leads every set view. */
export function countLine(n: number, unit = 'task'): string {
  return `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
}

/** Success line on stdout — the shared `✓`/`[ok]` glyph (color is decoration). */
export function ok(io: Io, text: string): void {
  const glyph = io.plain ? '[ok]' : '\x1b[32m✓\x1b[0m';
  io.write(`${glyph} ${text}`);
}

/**
 * The styled (human) formats carry prose — confirmations, signposts, hints;
 * the structured formats (`json`/`jsonl`/`ids`) stay a clean machine contract.
 */
export const isStyled = (format: Format): boolean => format === 'records' || format === 'table';

/**
 * A mutation's what-happened signpost, emitted above the echoed record on
 * styled formats only. The verb's effect (a transition, a re-parent, a
 * reorder) is often invisible in the lean record — rank is never a field
 * (ADR 0007), edges aren't echoed — so this line is the load-bearing signal
 * that the write landed. Structured formats carry only the record.
 */
export function signpost(io: Io, format: Format, text: string): void {
  if (isStyled(format)) {
    ok(io, text);
  }
}

/** Warning line on stderr — the shared `⚠`/`[warn]` glyph. */
export function warn(io: Io, text: string): void {
  const glyph = io.plain ? '[warn]' : '\x1b[33m⚠\x1b[0m';
  io.error(`${glyph} ${text}`);
}

function statusCell(status: StatusWord, width: number, plain: boolean): string {
  const style = STATUS_STYLE[status];
  const glyph = plain ? style.ascii : style.icon;
  return color(`${glyph} ${pad(status, width)}`, style.color, plain);
}

/** `table` — one task per line, count-led, in array (rank) order. */
export function renderTable(result: SetResult<NodeView>, io: Io, emptyMsg?: string): string {
  const lines = [countLine(result.total)];
  const items = result.items;
  if (items.length === 0) {
    if (io.isTTY && emptyMsg !== undefined) {
      lines.push('', emptyMsg);
    }
    return lines.join('\n');
  }
  lines.push('');
  const idW = Math.max(...items.map((n) => n.id.length));
  const stW = Math.max(...items.map((n) => n.status.length));
  // Parent id — the row's hierarchy anchor (MMR-87). A top-level node has none.
  const parentW = Math.max(...items.map((n) => (n.parent ?? '').length));
  for (const n of items) {
    const priority = n.priority ?? '';
    lines.push(
      `${pad(n.id, idW)}   ${statusCell(n.status, stW, io.plain)}   ${pad(priority, 2)}   ${pad(n.parent ?? '', parentW)}   ${n.title}`,
    );
  }
  return lines.join('\n');
}

function row(label: string, value: string, labelW: number): string {
  return `  ${pad(label, labelW)}  ${value}`;
}

/**
 * Build a rollup signpost suffix for a container's status line.
 * Returns `" (rollup over N direct children)"` for any non-task node,
 * including empty containers (n=0).
 * Prefers `children.length` (exact); falls back to summing the distribution.
 */
function rollupSignpost(node: NodeView): string {
  if (node.type === 'task') {
    return '';
  }
  let n = 0;
  if (node.children !== undefined) {
    n = node.children.length;
  } else if (node.distribution !== undefined) {
    n = Object.values(node.distribution).reduce((s, c) => s + c, 0);
  }
  return ` (rollup over ${String(n)} direct child${n === 1 ? '' : 'ren'})`;
}

/**
 * Build a rollup signpost suffix for a `StatusView` container.
 * Same logic as `rollupSignpost` but accepts the leaner `StatusView` shape.
 */
function statusRollupSignpost(status: StatusView): string {
  if (status.type === 'task') {
    return '';
  }
  const n = Object.values(status.distribution).reduce((s, c) => s + c, 0);
  return ` (rollup over ${String(n)} direct child${n === 1 ? '' : 'ren'})`;
}

/**
 * Build the TTY-only onward hint lines for a container node.
 * Shown on the single-node `records` styled view (and `status -f records`) on a TTY.
 * `table` (the set view) intentionally carries no per-entity hint.
 * Points to `mimir tree <id>` and the next leaf action.
 */
function buildOnwardHint(id: string, isContainer: boolean, io: Io): string {
  if (!io.isTTY) {
    return '';
  }
  if (!isContainer) {
    return '';
  }
  const projectKey = id.includes('-') ? id.split('-')[0] : id;
  const hintLines = [
    '',
    `  hint  mimir tree ${id}   — full subtree`,
    `        mimir list --status ready -s ${projectKey}   — leaf-actionable tasks`,
  ];
  return hintLines.join('\n');
}

function onwardHint(node: NodeView, io: Io): string {
  return buildOnwardHint(node.id, node.type !== 'task', io);
}

/** `records` — bold id header + aligned `label  value` rows, bare fields then facets. */
export function renderRecords(node: NodeView, io: Io): string {
  const lines = [bold(node.id, io.plain)];
  const isContainer = node.type !== 'task';
  const rollupNote = isContainer ? rollupSignpost(node) : '';
  const pairs: [string, string][] = [
    ['type', node.type],
    ['status', statusCell(node.status, node.status.length, io.plain) + rollupNote],
    ['title', node.title],
  ];
  if (node.parent !== null) {
    pairs.push(['parent', node.parent]);
  }
  if (node.description != null) {
    pairs.push(['description', node.description]);
  }
  if (node.priority != null) {
    pairs.push(['priority', node.priority]);
  }
  if (node.size != null) {
    pairs.push(['size', node.size]);
  }
  if (node.lifecycle !== undefined) {
    pairs.push(['lifecycle', node.lifecycle]);
  }
  if (node.hold !== undefined) {
    pairs.push(['hold', node.hold]);
  }
  if (node.holdReason != null) {
    pairs.push(['hold reason', node.holdReason]);
  }
  if (node.target != null) {
    pairs.push(['target', node.target]);
  }
  if (node.externalRef != null) {
    pairs.push(['external ref', node.externalRef]);
  }
  if (node.completedAt != null) {
    pairs.push(['completed', node.completedAt]);
  }

  if (node.deps !== undefined && node.deps.dependsOn.length > 0) {
    pairs.push([
      'depends on',
      node.deps.dependsOn.map((r) => (r.title ? `${r.id} · ${r.title}` : r.id)).join(', '),
    ]);
  }
  if (node.deps !== undefined && node.deps.awaitingOn.length > 0) {
    pairs.push([
      'awaiting on',
      node.deps.awaitingOn
        .map((r) => {
          const base = r.title ? `${r.id} · ${r.title}` : r.id;
          return r.via ? `${base} (via ${r.via})` : base;
        })
        .join(', '),
    ]);
  }
  if (node.deps !== undefined && node.deps.blocking.length > 0) {
    pairs.push([
      'blocking',
      node.deps.blocking.map((r) => (r.title ? `${r.id} · ${r.title}` : r.id)).join(', '),
    ]);
  }
  if (node.children !== undefined && node.children.length > 0) {
    pairs.push([
      'children',
      node.children
        .map((r) => {
          const base = r.title ? `${r.id} · ${r.title}` : r.id;
          return r.status ? `${base} (${r.status})` : base;
        })
        .join(', '),
    ]);
  }
  if (node.distribution !== undefined && Object.keys(node.distribution).length > 0) {
    const dist = Object.entries(node.distribution)
      .map(([word, count]) => `${word}:${String(count)}`)
      .join(', ');
    pairs.push(['distribution', dist]);
  }
  if (node.tags !== undefined && node.tags.length > 0) {
    pairs.push(['tags', node.tags.map((t) => t.tag).join(', ')]);
  }
  if (node.annotations !== undefined && node.annotations.length > 0) {
    pairs.push(['annotations', String(node.annotations.length)]);
  }
  if (node.artifacts !== undefined && node.artifacts.length > 0) {
    pairs.push(['artifacts', String(node.artifacts.length)]);
  }
  if (node.history !== undefined && node.history.length > 0) {
    pairs.push([
      'history',
      node.history.map((h) => `${h.kind} ${h.from ?? '-'}→${h.to ?? '-'}`).join('; '),
    ]);
  }
  if (node.verdicts !== undefined) {
    const holding = Object.entries(node.verdicts)
      .filter(([, holds]) => holds)
      .map(([verdict]) => verdict)
      .join(', ');
    pairs.push(['verdicts', holding === '' ? '(none)' : holding]);
  }

  const labelW = Math.max(...pairs.map(([label]) => label.length));
  for (const [label, value] of pairs) {
    lines.push(row(label, value, labelW));
  }
  const hint = onwardHint(node, io);
  if (hint) {
    lines.push(hint);
  }
  return lines.join('\n');
}

/**
 * Render a single node to `io` in the given format. Exhaustive over all five
 * `Format` values — TypeScript enforces no gaps. No `default` branch so the
 * compiler catches any missing case (no import from `./errors` to avoid the
 * render↔errors import cycle).
 */
export function renderNodeView(view: NodeView, format: Format, io: Io): void {
  switch (format) {
    case 'json':
    case 'jsonl': {
      io.write(formatNodeJson(view));
      break;
    }
    case 'ids': {
      io.write(view.id);
      break;
    }
    case 'table': {
      io.write(renderTable({ items: [view], returned: 1, startsAt: 0, total: 1 }, io));
      break;
    }
    case 'records': {
      io.write(renderRecords(view, io));
      break;
    }
  }
}

/** Render a standalone artifact (`get KEY-aN`) in any format — metadata + links (MMR-32). */
export function renderArtifactDetail(artifact: ArtifactDetail, format: Format, io: Io): void {
  switch (format) {
    case 'json':
    case 'jsonl': {
      io.write(formatArtifactJson(artifact));
      break;
    }
    case 'ids': {
      io.write(artifact.id);
      break;
    }
    case 'table': {
      const tags = artifact.tags.length > 0 ? `   ${artifact.tags.join(', ')}` : '';
      io.write(
        [
          countLine(1, 'artifact'),
          '',
          `${artifact.id}   ${artifact.title}${tags}   ${artifact.createdAt}`,
        ].join('\n'),
      );
      break;
    }
    case 'records': {
      const pairs: [string, string][] = [
        ['title', artifact.title],
        ['project', artifact.project],
      ];
      if (artifact.links.length > 0) {
        pairs.push(['links', artifact.links.join(', ')]);
      }
      if (artifact.tags.length > 0) {
        pairs.push(['tags', artifact.tags.join(', ')]);
      }
      pairs.push(['created', artifact.createdAt]);
      const labelW = Math.max(...pairs.map(([label]) => label.length));
      const lines = [bold(artifact.id, io.plain), ...pairs.map(([l, v]) => row(l, v, labelW))];
      if (artifact.content !== undefined) {
        lines.push('', artifact.content);
      }
      io.write(lines.join('\n'));
      break;
    }
  }
}

/** `records`-style rendering of `status_of` — label + distribution, with rollup signpost and TTY hint for containers. */
export function renderStatus(status: StatusView, io: Io): string {
  const dist = Object.entries(status.distribution)
    .map(([word, count]) => `${word}:${String(count)}`)
    .join(', ');
  const isContainer = status.type !== 'task';
  const rollupNote = isContainer ? statusRollupSignpost(status) : '';
  const lines = [
    bold(status.id, io.plain),
    row('status', statusCell(status.status, status.status.length, io.plain) + rollupNote, 12),
    row('distribution', dist === '' ? '(none)' : dist, 12),
  ];
  const hint = buildOnwardHint(status.id, isContainer, io);
  if (hint) {
    lines.push(hint);
  }
  return lines.join('\n');
}

/**
 * `tree` — compact indented hierarchy: `id · status · title`, rank-then-seq
 * order (children already arrive in that order from `nodeTree`/`projectTree`).
 * Each depth level is indented by two spaces. The root node is unindented.
 */
export function renderTree(tree: TreeView, io: Io, depth = 0): string {
  const indent = '  '.repeat(depth);
  const statusGlyph = statusCell(tree.status, tree.status.length, io.plain);
  const line = `${indent}${tree.id} · ${statusGlyph} · ${tree.title}`;
  const childLines = tree.children.map((child) => renderTree(child, io, depth + 1));
  return [line, ...childLines].join('\n');
}
