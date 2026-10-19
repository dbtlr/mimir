/**
 * The styled node views, `table` (a set) and `records` (one record), ported
 * from the old CLI's renderer. Layout is evolvable and never parsed (ADR
 * 0009); the parity harness holds it to the old CLI's bytes, and any change is
 * an entry in the checked-in difference list.
 */
import type { AnnotationView, NodeView, SetResult, StatusWord } from '@mimir/contract';
import { formatInstant } from '@mimir/helpers';

import { arrow, bold, color, countLine, pad } from './presentation';
import type { Presentation } from './presentation';

type StatusStyle = { icon: string; ascii: string; color: number };

const STATUS_STYLE: Record<StatusWord, StatusStyle> = {
  abandoned: { ascii: 'X', color: 90, icon: '✗' },
  awaiting: { ascii: '~', color: 33, icon: '◔' },
  blocked: { ascii: 'x', color: 31, icon: '■' },
  done: { ascii: 'v', color: 32, icon: '✓' },
  in_progress: { ascii: '>', color: 36, icon: '▶' },
  new: { ascii: 'o', color: 90, icon: '○' },
  parked: { ascii: '=', color: 90, icon: '⏸' },
  queued: { ascii: '=', color: 34, icon: '◷' },
  ready: { ascii: '*', color: 32, icon: '●' },
  under_review: { ascii: '?', color: 35, icon: '◎' },
};

function statusCell(status: StatusWord, width: number, plain: boolean): string {
  const style = STATUS_STYLE[status];
  return color(`${plain ? style.ascii : style.icon} ${pad(status, width)}`, style.color, plain);
}

/** The grooming word a row shows (ADR 0033): only a `todo` task reads it. */
const groomingCell = (n: NodeView): string =>
  n.lifecycle === 'todo' && n.grooming !== undefined ? n.grooming : '';

/**
 * One line per task: id, status cell, priority, grooming, parent, title, aligned
 * over `items`, with the `--col lede` preview as a dim second line. The grooming
 * column appears only when some row has a state to show. `items` is non-empty.
 */
export function taskRows(items: readonly NodeView[], p: Presentation): string[] {
  const idW = Math.max(...items.map((n) => n.id.length));
  const stW = Math.max(...items.map((n) => n.status.length));
  const parentW = Math.max(...items.map((n) => (n.parent ?? '').length));
  const groomW = Math.max(...items.map((n) => groomingCell(n).length));
  return items.map((n) => {
    const grooming = groomW === 0 ? '' : `${pad(groomingCell(n), groomW)}   `;
    const head = `${pad(n.id, idW)}   ${statusCell(n.status, stW, p.plain)}   ${pad(n.priority ?? '', 2)}   ${grooming}${pad(n.parent ?? '', parentW)}   ${n.title}`;
    return n.lede == null || n.lede === ''
      ? head
      : `${head}\n${color(`      ${n.lede}`, 90, p.plain)}`;
  });
}

/** `table`: the count line, then one row per node in rank order. `emptyMessage` prints on a terminal. */
export function renderTable(
  result: SetResult<NodeView>,
  p: Presentation,
  unit: string,
  emptyMessage?: string,
): string {
  const lines = [countLine(result.total, unit)];
  if (result.items.length === 0) {
    if (p.isTTY && emptyMessage !== undefined) {
      lines.push('', emptyMessage);
    }
    return lines.join('\n');
  }
  lines.push('', ...taskRows(result.items, p));
  return lines.join('\n');
}

/** One aligned `label  value` row; a multi-line value indents under the value column. */
export function recordRow(label: string, value: string, labelW: number): string {
  const [first, ...rest] = value.split('\n');
  if (rest.length === 0) {
    return `  ${pad(label, labelW)}  ${first}`;
  }
  const indent = ' '.repeat(labelW + 4);
  return [`  ${pad(label, labelW)}  ${first}`, ...rest.map((line) => indent + line)].join('\n');
}

/** The `--col annotations` expansion: each entry's timestamp leads its content, one entry per line. */
function annotationsExpanded(annotations: readonly AnnotationView[], zone: string): string {
  const lines: string[] = [];
  for (const a of annotations) {
    const [firstLine, ...rest] = a.content.split('\n');
    lines.push(`${formatInstant(a.createdAt, zone)} — ${firstLine}`, ...rest);
  }
  return lines.join('\n');
}

/** A container's status suffix, ` (rollup over N direct children)`. */
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

/** A container's terminal-only pointers to its subtree and its actionable leaves. */
function onwardHint(node: NodeView, p: Presentation): string {
  if (!p.isTTY || node.type === 'task') {
    return '';
  }
  const projectKey = node.id.includes('-') ? node.id.split('-')[0] : node.id;
  return [
    '',
    `  hint  mimir tree ${node.id}   — full subtree`,
    `        mimir list --status ready -s ${projectKey}   — leaf-actionable tasks`,
  ].join('\n');
}

const refLine = (r: { id: string; title?: string | undefined }): string =>
  r.title ? `${r.id} · ${r.title}` : r.id;

/** The bare fields a node shows when set, in display order. */
function fieldPairs(node: NodeView, p: Presentation): [string, string][] {
  const isContainer = node.type !== 'task';
  const pairs: [string, string][] = [
    ['type', node.type],
    [
      'status',
      statusCell(node.status, node.status.length, p.plain) +
        (isContainer ? rollupSignpost(node) : ''),
    ],
    ['title', node.title],
  ];
  const optional: [string, string | null | undefined][] = [
    ['parent', node.parent],
    ['description', node.description],
    ['next', node.next],
    ['summary', node.summary],
    ['lede', node.lede],
    ['priority', node.priority],
    ['size', node.size],
    ['lifecycle', node.lifecycle],
    ['grooming', node.grooming],
    ['hold', node.hold],
    ['hold reason', node.holdReason],
    ['block owner', node.blockOwner],
    ['target', node.target],
    ['open-ended', node.open_ended === true ? 'yes' : undefined],
    ['pinned', node.pinned === true ? 'yes' : undefined],
    ['remote', node.remote],
    ['external ref', node.externalRef],
    ['upstream', node.upstream],
    ['host', node.host],
    ['harness', node.harness],
    ['session', node.session],
    ['worker harness', node.workerHarness],
    ['worker session', node.workerSession],
    ['branch', node.branch],
    ['completed', node.completedAt == null ? undefined : formatInstant(node.completedAt, p.zone)],
    [
      'last activity',
      node.lastActivityAt === undefined ? undefined : formatInstant(node.lastActivityAt, p.zone),
    ],
  ];
  for (const [label, value] of optional) {
    if (value != null) {
      pairs.push([label, value]);
    }
  }
  return pairs;
}

/** The facets a node shows when requested and non-empty, in display order. */
function facetPairs(
  node: NodeView,
  p: Presentation,
  expandAnnotations: boolean,
): [string, string][] {
  const pairs: [string, string][] = [];
  const deps = node.deps;
  if (deps !== undefined && deps.dependsOn.length > 0) {
    pairs.push(['depends on', deps.dependsOn.map(refLine).join(', ')]);
  }
  if (deps !== undefined && deps.awaitingOn.length > 0) {
    pairs.push([
      'awaiting on',
      deps.awaitingOn.map((r) => (r.via ? `${refLine(r)} (via ${r.via})` : refLine(r))).join(', '),
    ]);
  }
  if (deps !== undefined && deps.blocking.length > 0) {
    pairs.push(['blocking', deps.blocking.map(refLine).join(', ')]);
  }
  if (node.children !== undefined && node.children.length > 0) {
    pairs.push([
      'children',
      node.children.map((r) => (r.status ? `${refLine(r)} (${r.status})` : refLine(r))).join(', '),
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
    pairs.push([
      'annotations',
      expandAnnotations
        ? annotationsExpanded(node.annotations, p.zone)
        : String(node.annotations.length),
    ]);
  }
  if (node.artifacts !== undefined && node.artifacts.length > 0) {
    pairs.push(['artifacts', String(node.artifacts.length)]);
  }
  if (node.history !== undefined && node.history.length > 0) {
    pairs.push([
      'history',
      node.history
        .map((h) => `${h.kind} ${h.from ?? '-'} ${arrow(p.plain)} ${h.to ?? '-'}`)
        .join('; '),
    ]);
  }
  if (node.verdicts !== undefined) {
    const holding = Object.entries(node.verdicts)
      .filter(([, holds]) => holds)
      .map(([verdict]) => verdict)
      .join(', ');
    pairs.push(['verdicts', holding === '' ? '(none)' : holding]);
  }
  return pairs;
}

/**
 * `records`: a bold id header and aligned `label  value` rows, bare fields then
 * facets, and a container's onward hint on a terminal. `expandAnnotations` is
 * the `--col annotations` opt-in; by default the annotations row is a count.
 */
export function renderRecords(node: NodeView, p: Presentation, expandAnnotations = false): string {
  const pairs = [...fieldPairs(node, p), ...facetPairs(node, p, expandAnnotations)];
  const labelW = Math.max(...pairs.map(([label]) => label.length));
  const lines = [bold(node.id, p.plain), ...pairs.map(([l, v]) => recordRow(l, v, labelW))];
  const hint = onwardHint(node, p);
  if (hint !== '') {
    lines.push(hint);
  }
  return lines.join('\n');
}
