import type {
  ArtifactDetail,
  NodeView,
  OverviewReport,
  SeedView,
  SetResult,
  StatusView,
  StatusWord,
  TreeView,
  TriageReport,
} from '@mimir/contract';

import {
  formatArtifactJson,
  formatNodeJson,
  formatPromoteJson,
  formatSeedsJson,
  formatSeedsJsonl,
  formatTriageJson,
  formatTriageJsonl,
  seedLane,
} from '../core';

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

/**
 * The lean task rows — one task per line, `id`, state cell, `priority`, `parent`,
 * `title`, aligned over the given items (MMR-87). The single row grammar shared by
 * `table` (the set view) and the `overview` composite (MMR-278) — never a second
 * spelling. Callers guard emptiness (the width `Math.max` needs ≥1 item).
 */
export function taskRows(items: readonly NodeView[], io: Io): string[] {
  const idW = Math.max(...items.map((n) => n.id.length));
  const stW = Math.max(...items.map((n) => n.status.length));
  // Parent id — the row's hierarchy anchor (MMR-87). A top-level node has none.
  const parentW = Math.max(...items.map((n) => (n.parent ?? '').length));
  return items.map(
    (n) =>
      `${pad(n.id, idW)}   ${statusCell(n.status, stW, io.plain)}   ${pad(n.priority ?? '', 2)}   ${pad(n.parent ?? '', parentW)}   ${n.title}`,
  );
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
  lines.push('', ...taskRows(items, io));
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
  if (node.summary != null) {
    pairs.push(['summary', node.summary]);
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
  // Container-only (MMR-204) — shown only when set, so a standing home is legible
  // in the default `get` view (not just `-f json`), like the console badge.
  if (node.open_ended === true) {
    pairs.push(['open-ended', 'yes']);
  }
  if (node.externalRef != null) {
    pairs.push(['external ref', node.externalRef]);
  }
  if (node.upstream != null) {
    pairs.push(['upstream', node.upstream]);
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

// ─── Seeds (MMR-245) ────────────────────────────────────────────────────────

/** A seed's `records` detail — bold id header + aligned rows (verb-owned
 * relations shown only when present). */
export function renderSeedRecords(seed: SeedView, io: Io): string {
  const pairs: [string, string][] = [
    ['project', seed.project],
    ['title', seed.title],
    ['kind', seed.kind],
    ['lifecycle', seed.lifecycle],
  ];
  if (seed.requester !== null) {
    pairs.push(['requester', seed.requester]);
  }
  if (seed.spawned.length > 0) {
    pairs.push(['spawned', seed.spawned.join(', ')]);
  }
  if (seed.readyToResolve) {
    pairs.push(['ready', 'ready to resolve']);
  }
  if (seed.description != null && seed.description !== '') {
    pairs.push(['description', seed.description]);
  }
  pairs.push(['created', seed.createdAt]);
  const labelW = Math.max(...pairs.map(([label]) => label.length));
  return [bold(seed.id, io.plain), ...pairs.map(([l, v]) => row(l, v, labelW))].join('\n');
}

/** One queue row: kind · lifecycle · requester · age · id · title (aligned), with
 * the derived lede (MMR-263) as a dimmed second line when the live seed carries a
 * body — the queue's own preview of the `## Seed Description`, so `mimir seeds`
 * shows the prose that used to hide in the detail read. */
export function seedRows(seeds: readonly SeedView[], io: Io): string[] {
  const kindW = Math.max(...seeds.map((s) => s.kind.length));
  const lifeW = Math.max(...seeds.map((s) => s.lifecycle.length));
  const reqW = Math.max(...seeds.map((s) => (s.requester ?? '-').length));
  const idW = Math.max(...seeds.map((s) => s.id.length));
  const ageW = Math.max(...seeds.map((s) => s.createdAt.length));
  const readyGlyph = io.plain ? ' *' : ' \x1b[32m●\x1b[0m';
  return seeds.map((s) => {
    const ready = s.readyToResolve ? readyGlyph : '';
    const head = `${pad(s.kind, kindW)}   ${pad(s.lifecycle, lifeW)}   ${pad(s.requester ?? '-', reqW)}   ${pad(s.createdAt, ageW)}   ${pad(s.id, idW)}   ${s.title}${ready}`;
    if (s.lede == null || s.lede === '') {
      return head;
    }
    return `${head}\n${color(`      ${s.lede}`, 90, io.plain)}`;
  });
}

/** `table` — the flat queue, count-led, oldest-first (the caller ordered it). */
function renderSeedTable(seeds: readonly SeedView[], io: Io, emptyMsg?: string): string {
  const lines = [countLine(seeds.length, 'seed')];
  if (seeds.length === 0) {
    if (io.isTTY && emptyMsg !== undefined) {
      lines.push('', emptyMsg);
    }
    return lines.join('\n');
  }
  lines.push('', ...seedRows(seeds, io));
  return lines.join('\n');
}

/** The `--grouped` lane view (MMR-245): UNTRIAGED / READY TO RESOLVE / SETTLED,
 * each with a count. A promoted seed whose spawned work is not all settled is
 * shown in a PROMOTED lane (only when populated) so no seed is dropped. */
function renderSeedGrouped(seeds: readonly SeedView[], io: Io): string {
  // Bucket by the shared classifier (M1) so the lane view can't drift from the wire
  // `lane` field — one source of the untriaged/ready/promoted/settled partition.
  const inLane = (lane: string): SeedView[] => seeds.filter((s) => seedLane(s) === lane);
  const lanes: [string, SeedView[]][] = [
    ['UNTRIAGED', inLane('untriaged')],
    ['READY TO RESOLVE', inLane('ready')],
    ['PROMOTED', inLane('promoted')],
    ['SETTLED', inLane('settled')],
  ];
  const out: string[] = [countLine(seeds.length, 'seed')];
  for (const [label, lane] of lanes) {
    // The three headline lanes always show (with a count); PROMOTED only when populated.
    if (label === 'PROMOTED' && lane.length === 0) {
      continue;
    }
    out.push('', bold(`${label} (${String(lane.length)})`, io.plain));
    if (lane.length > 0) {
      out.push(...seedRows(lane, io));
    }
  }
  return out.join('\n');
}

/** Render the seed queue in any format; `grouped` selects the lane view (styled only). */
export function renderSeeds(
  seeds: readonly SeedView[],
  format: Format,
  io: Io,
  opts: { grouped?: boolean; emptyMsg?: string } = {},
): void {
  switch (format) {
    case 'json': {
      io.write(formatSeedsJson(seeds));
      break;
    }
    case 'jsonl': {
      io.write(formatSeedsJsonl(seeds));
      break;
    }
    case 'ids': {
      io.write(seeds.map((s) => s.id).join('\n'));
      break;
    }
    case 'records':
    case 'table': {
      io.write(
        opts.grouped === true
          ? renderSeedGrouped(seeds, io)
          : renderSeedTable(seeds, io, opts.emptyMsg),
      );
      break;
    }
  }
}

/** Render one seed (a `get`/write echo) in any format. `created` is the promote
 * echo's sibling task id (MMR-245) — undefined everywhere but `promote` create
 * mode, where {@link formatPromoteJson} folds it in identically to MCP/HTTP.
 * `idsTarget` overrides the `ids`-format id — `promote` passes the spawned or
 * linked id (MMR-259) so a composer's `$(mimir promote … -f ids)` captures the
 * task it just made, not the seed; every other verb leaves it unset and echoes
 * the seed id as before. */
export function renderSeedView(
  seed: SeedView,
  format: Format,
  io: Io,
  created?: string,
  idsTarget?: string,
): void {
  switch (format) {
    case 'json':
    case 'jsonl': {
      io.write(formatPromoteJson(seed, created));
      break;
    }
    case 'ids': {
      io.write(idsTarget ?? seed.id);
      break;
    }
    case 'table':
    case 'records': {
      io.write(renderSeedRecords(seed, io));
      break;
    }
  }
}

/** The check-(c) per-row state word: what happened (or would happen) to the task. */
function resolutionState(alreadyRecorded: boolean, dryRun: boolean): string {
  if (alreadyRecorded) {
    return 'already recorded';
  }
  return dryRun ? 'would annotate' : 'annotated';
}

/** The human triage report (MMR-246): a lede line with per-check counts, then the
 * three sections — UNTRIAGED / READY TO RESOLVE / UPSTREAM RESOLUTIONS. A report,
 * never a gate: this always renders (exit 0), even when everything is clean. */
export function renderTriageReport(report: TriageReport, io: Io): string {
  const res = report.upstreamResolutions;
  const wrote = res.filter((r) => r.annotated).length;
  const already = res.filter((r) => r.alreadyRecorded).length;
  const wouldAnnotate = res.filter((r) => !r.alreadyRecorded && !r.annotated).length;
  // The check-(c) tally: annotated in a normal run, "would annotate" under --dry-run.
  const cParts = [
    report.dryRun ? `${String(wouldAnnotate)} would annotate` : `${String(wrote)} annotated`,
    `${String(already)} already recorded`,
  ];
  const counts = `${countLine(report.untriaged.length, 'untriaged seed')} · ${String(report.readyToResolve.length)} ready to resolve · ${countLine(res.length, 'upstream resolution')} (${cParts.join(', ')})`;
  const lede = [
    bold(`triage ${report.board}`, io.plain),
    report.failures.length > 0
      ? `${counts} · ${countLine(report.failures.length, 'skipped')}`
      : counts,
  ];
  if (report.dryRun) {
    lede.push(
      io.plain
        ? '[dry run — no annotations written]'
        : '\x1b[90m(dry run — no annotations written)\x1b[0m',
    );
  }
  const out: string[] = [lede.join('\n')];

  out.push('', bold(`UNTRIAGED (${String(report.untriaged.length)})`, io.plain));
  if (report.untriaged.length > 0) {
    out.push(...seedRows(report.untriaged, io));
  }
  out.push('', bold(`READY TO RESOLVE (${String(report.readyToResolve.length)})`, io.plain));
  if (report.readyToResolve.length > 0) {
    out.push(...seedRows(report.readyToResolve, io));
  }
  out.push('', bold(`UPSTREAM RESOLUTIONS (${String(res.length)})`, io.plain));
  for (const r of res) {
    const arrow = io.plain ? '<-' : '←';
    const head = `${r.task} ${arrow} ${r.upstream} ${r.lifecycle}`;
    const reason = r.reason !== null && r.reason !== '' ? `: ${r.reason}` : '';
    const state = resolutionState(r.alreadyRecorded, report.dryRun);
    const unblock = r.blocked ? ` · blocked → suggest: mimir unblock ${r.task}` : '';
    out.push(`${head}${reason}   ${state}${unblock}`);
  }

  // Skipped check-(c) tasks (corrupt anchor / read fault) — surfaced so the loss is
  // visible; the pass itself still succeeds (exit 0), like `doctor` findings.
  if (report.failures.length > 0) {
    out.push('', bold(`SKIPPED (${String(report.failures.length)})`, io.plain));
    for (const f of report.failures) {
      out.push(`${f.task}: ${f.message}`);
    }
  }
  return out.join('\n');
}

/** Render the triage report in any format; `report` mode picks human vs json upstream. */
export function renderTriage(report: TriageReport, format: Format, io: Io): void {
  switch (format) {
    case 'json': {
      io.write(formatTriageJson(report));
      break;
    }
    case 'jsonl': {
      io.write(formatTriageJsonl(report));
      break;
    }
    case 'ids': {
      // The actionable ids: the tasks with a settled upstream (check c).
      io.write(report.upstreamResolutions.map((r) => r.task).join('\n'));
      break;
    }
    case 'records':
    case 'table': {
      io.write(renderTriageReport(report, io));
      break;
    }
  }
}

/** One spelling for a rollup distribution — `word:count` pairs, comma-joined. */
function formatDistribution(distribution: Readonly<Record<string, number>>): string {
  return Object.entries(distribution)
    .map(([word, count]) => `${word}:${String(count)}`)
    .join(', ');
}

/** `records`-style rendering of `status_of` — label + distribution, with rollup signpost and TTY hint for containers. */
export function renderStatus(status: StatusView, io: Io): string {
  const dist = formatDistribution(status.distribution);
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
 * `overview` — the composite session-boot orientation surface (MMR-278). Five
 * attention-ordered sections: the project header (id · status word · rollup
 * distribution), `in flight` (uncapped), `next` and `awaiting` (top 5, each led
 * by its TRUE total), then hygiene counts. Rows reuse the shared lean row grammar
 * ({@link taskRows}) verbatim; an awaiting row appends the upstream ids it awaits
 * as a `·`-separated clause. An empty section renders just its zero-count header.
 */
export function renderOverview(report: OverviewReport, io: Io): string {
  const out: string[] = [];

  // header — project id · status word · rollup distribution.
  const { id, status, distribution } = report.project;
  const dist = formatDistribution(distribution);
  const head = [bold(id, io.plain), statusCell(status, status.length, io.plain)];
  if (dist !== '') {
    head.push(dist);
  }
  out.push(head.join(' · '));

  const taskSection = (label: string, count: number, tasks: readonly NodeView[]): void => {
    out.push('', `${label} (${String(count)})`);
    if (tasks.length > 0) {
      for (const line of taskRows(tasks, io)) {
        out.push(`  ${line}`);
      }
    }
  };

  taskSection('in flight', report.inFlight.count, report.inFlight.tasks);
  taskSection('next', report.next.count, report.next.tasks);

  // awaiting — same rows, each with its upstream ids as a `·` clause.
  out.push('', `awaiting (${String(report.awaiting.count)})`);
  if (report.awaiting.tasks.length > 0) {
    const rows = taskRows(
      report.awaiting.tasks.map((a) => a.task),
      io,
    );
    rows.forEach((line, i) => {
      const ids = report.awaiting.tasks[i]?.awaitingOn ?? [];
      out.push(`  ${ids.length > 0 ? `${line} · awaiting ${ids.join(', ')}` : line}`);
    });
  }

  // hygiene — counts only; each nonzero count names its follow-up command,
  // scoped to the reported project so the pointer stays true under `-s KEY`
  // (the dropped count is the whole-vault tally, MMR-184 — its `doctor`
  // pointer stays unscoped to match).
  const { untriaged, blocked, stale, dropped } = report.hygiene;
  const hygiene: string[] = [];
  if (untriaged > 0) {
    hygiene.push(`${countLine(untriaged, 'untriaged seed')} — run 'mimir triage ${id}'`);
  }
  if (blocked > 0) {
    hygiene.push(`${String(blocked)} blocked — run 'mimir list -s ${id} --status blocked'`);
  }
  if (stale > 0) {
    hygiene.push(`${String(stale)} stale — run 'mimir list -s ${id} --is stale'`);
  }
  if (dropped > 0) {
    hygiene.push(`${countLine(dropped, 'dropped record')} — run 'mimir doctor'`);
  }
  out.push('', 'hygiene');
  out.push(...(hygiene.length === 0 ? ['  nothing flagged'] : hygiene.map((line) => `  ${line}`)));

  return out.join('\n');
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
