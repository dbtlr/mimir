/**
 * The styled views of the single-record reads that are not a node: `status`,
 * `tree`, and the `overview` composite, ported from the old CLI's renderer.
 * Layout is evolvable and never parsed (ADR 0009); the parity harness holds it
 * to the old CLI's bytes.
 */
import type {
  NodeView,
  OverviewAttentionTask,
  OverviewReport,
  StatusView,
  TreeView,
} from '@mimir/contract';
import { UNREADABLE, formatInstant, relativeTime } from '@mimir/helpers';

import {
  containerHint,
  formatDistribution,
  recordRow,
  rollupPhrase,
  statusCell,
  taskRows,
} from './node';
import { arrow, bold, countLine, dimmed } from './presentation';
import type { Presentation } from './presentation';

/** A container's status suffix, ` (rollup over N direct children)`. */
function statusRollupSignpost(status: StatusView): string {
  if (status.type === 'task') {
    return '';
  }
  const n = Object.values(status.distribution).reduce((s, c) => s + c, 0);
  return rollupPhrase(n);
}

/** `status`: the label and distribution, with a rollup signpost and terminal hint for a container. */
export function renderStatus(status: StatusView, p: Presentation): string {
  const dist = formatDistribution(status.distribution);
  const isContainer = status.type !== 'task';
  const lines = [
    bold(status.id, p.plain),
    recordRow(
      'status',
      statusCell(status.status, status.status.length, p.plain) + statusRollupSignpost(status),
      12,
    ),
    recordRow('distribution', dist === '' ? '(none)' : dist, 12),
  ];
  const hint = containerHint(status.id, isContainer, p);
  if (hint) {
    lines.push(hint);
  }
  return lines.join('\n');
}

/** `tree`: the compact indented hierarchy, `id · status · title`, two spaces per level. */
export function renderTree(tree: TreeView, p: Presentation, depth = 0): string {
  const indent = '  '.repeat(depth);
  const statusGlyph = statusCell(tree.status, tree.status.length, p.plain);
  const line = `${indent}${tree.id} · ${statusGlyph} · ${tree.title}`;
  return [line, ...tree.children.map((child) => renderTree(child, p, depth + 1))].join('\n');
}

/** The in-flight resume-handle clause: `harness@host · branch · session`, each part omitted when unset. */
function handleClause(task: NodeView): string {
  const where =
    task.harness != null && task.host != null
      ? `${task.harness}@${task.host}`
      : (task.harness ?? task.host ?? null);
  const parts = [where, task.branch, task.session].filter(
    (part): part is string => part != null && part !== '',
  );
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
}

/**
 * A session's activity window as one local reading, `2026-08-05 09:14 → 09:43
 * EDT`: the zone label once, and the date elided on the closing edge when both
 * edges land on the same local day.
 */
function sessionWindow(from: string, to: string, p: Presentation): string {
  const reading = (iso: string): { day: string; label: string; time: string } => {
    const [day = '', time = '', label = ''] = formatInstant(iso, p.zone).split(' ');
    return { day, label, time };
  };
  if (formatInstant(from, p.zone) === UNREADABLE || formatInstant(to, p.zone) === UNREADABLE) {
    return UNREADABLE;
  }
  const glyph = arrow(p.plain);
  const [open, close] = [reading(from), reading(to)];
  if (open.label === '' || open.label !== close.label) {
    return `${formatInstant(from, p.zone)} ${glyph} ${formatInstant(to, p.zone)}`;
  }
  const closing = open.day === close.day ? close.time : `${close.day} ${close.time}`;
  return `${open.day} ${open.time} ${glyph} ${closing} ${open.label}`;
}

/**
 * `overview`: the session-boot orientation composite. Attention-ordered
 * sections: the project header, the owned direction prose, in flight, active
 * scratchpads, next, awaiting, recent sessions, then hygiene counts with their
 * capped listings. An empty section renders just its zero-count header.
 */
export function renderOverview(report: OverviewReport, p: Presentation): string {
  const out: string[] = [];
  const { id, status, distribution } = report.project;
  const dist = formatDistribution(distribution);
  const head = [bold(id, p.plain), statusCell(status, status.length, p.plain)];
  if (dist !== '') {
    head.push(dist);
  }
  out.push(head.join(' · '));

  const { project: projectNext, containers, count: directionCount } = report.direction;
  if (projectNext != null || containers.length > 0) {
    out.push('', 'direction');
    if (projectNext != null) {
      out.push(...projectNext.split('\n').map((line) => `  ${line}`));
    }
    for (const container of containers) {
      out.push(`  ${bold(container.id, p.plain)} · ${container.title}`);
      out.push(...container.next.split('\n').map((line) => `    ${line}`));
    }
    // The list caps at 5 though the count is true: name the remainder.
    const hidden = directionCount - containers.length;
    if (hidden > 0) {
      out.push(`  ${String(hidden)} more with direction — run 'mimir get <id>'`);
    }
  }

  const taskSection = (
    label: string,
    count: number,
    tasks: readonly NodeView[],
    suffix: (task: NodeView) => string = () => '',
  ): void => {
    out.push('', `${label} (${String(count)})`);
    if (tasks.length > 0) {
      taskRows(tasks, p).forEach((line, i) => {
        const task = tasks[i];
        out.push(`  ${line}${task === undefined ? '' : suffix(task)}`);
      });
    }
  };

  taskSection('in flight', report.inFlight.count, report.inFlight.tasks, handleClause);

  out.push('', `active scratchpads (${String(report.scratchpads.count)})`);
  const now = Date.now();
  for (const scratchpad of report.scratchpads.scratchpads) {
    const state = scratchpad.state === 'freezing' ? 'freezing · ' : '';
    const links =
      scratchpad.linkedWork.length === 0 ? '' : ` · linked ${scratchpad.linkedWork.join(', ')}`;
    out.push(
      `  ${state}${scratchpad.id} · ${scratchpad.project} · ${scratchpad.title} · ${String(scratchpad.openAgenda)} open Agenda · ${relativeTime(scratchpad.updatedAt, now)}${links}`,
    );
  }

  taskSection('next', report.next.count, report.next.tasks);

  out.push('', `awaiting (${String(report.awaiting.count)})`);
  if (report.awaiting.tasks.length > 0) {
    const rows = taskRows(
      report.awaiting.tasks.map((a) => a.task),
      p,
    );
    rows.forEach((line, i) => {
      const ids = report.awaiting.tasks[i]?.awaitingOn ?? [];
      out.push(`  ${ids.length > 0 ? `${line} · awaiting ${ids.join(', ')}` : line}`);
    });
  }

  // `shown`, not a bare count: this section is composed from bounded reads.
  out.push('', `recent sessions (${String(report.sessions.shown)} shown)`);
  for (const entry of report.sessions.entries) {
    const parts = [entry.id ?? '(no session)', sessionWindow(entry.from, entry.to, p)];
    if (entry.transitions > 0) {
      parts.push(countLine(entry.transitions, 'transition'));
    }
    if (entry.tasks.length > 0) {
      parts.push(entry.tasks.map((task) => task.id).join(', '));
    }
    out.push(`  ${parts.join(' · ')}`);
    if (entry.artifact !== undefined) {
      const lede = entry.artifact.summary ?? entry.artifact.title;
      out.push(dimmed(`    ${entry.artifact.id} · ${lede}`, p.plain));
    }
  }

  const { untriaged, blocked, stale, listings, parkedSeeds } = report.hygiene;
  out.push('', 'hygiene');
  const hygiene: string[] = [];
  const pushAttention = (rows: readonly OverviewAttentionTask[]): void => {
    if (rows.length === 0) {
      return;
    }
    taskRows(
      rows.map((r) => r.task),
      p,
    ).forEach((line, i) => {
      const entry = rows[i];
      if (entry === undefined) {
        return;
      }
      const cold = entry.stale ? ' · going cold' : '';
      const reason = entry.task.holdReason == null ? '' : ` · ${entry.task.holdReason}`;
      hygiene.push(`  ${line}${reason}${cold}`);
    });
  };
  if (untriaged > 0) {
    hygiene.push(`${countLine(untriaged, 'untriaged seed')} — run 'mimir triage ${id}'`);
    for (const seed of listings.untriaged) {
      const lede = seed.lede == null || seed.lede === '' ? '' : ` · ${seed.lede}`;
      hygiene.push(`  ${seed.id}   ${seed.title}${lede}`);
    }
  }
  if (blocked > 0) {
    hygiene.push(`${String(blocked)} blocked — run 'mimir list -s ${id} --status blocked'`);
    pushAttention(listings.blocked);
  }
  if (stale > 0) {
    hygiene.push(`${String(stale)} stale — run 'mimir list -s ${id} --is stale'`);
    pushAttention(listings.stale);
  }
  out.push(...(hygiene.length === 0 ? ['  nothing flagged'] : hygiene.map((line) => `  ${line}`)));
  if (parkedSeeds > 0) {
    out.push(
      `  ${countLine(parkedSeeds, 'parked seed')} — list them: mimir seeds -p ${id} --status parked`,
    );
  }
  return out.join('\n');
}
