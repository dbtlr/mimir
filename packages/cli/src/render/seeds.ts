/**
 * The seed write echoes and the triage report, ported from the old CLI's
 * renderer (MMR-552). A seed write echoes the seed it changed, led on the
 * styled formats by a one-line signpost that says what happened.
 */
import type { SeedView, TriageReport } from '@mimir/contract';

import type { Ports } from '../ports';
import { seedRows } from './feeds';
import { arrow, bold, countLine, dimmed, okLine } from './presentation';
import type { Presentation } from './presentation';
import { renderSeedRecords } from './records';
import { compactJson, prettyJson, recordViews } from './views';

/** A seed write's echo: the seed, its wire object, and the signpost the styled views lead with. */
export type SeedEcho = {
  seed: SeedView;
  wire: Record<string, unknown>;
  signpost: string;
  /** The id `ids` prints when it is not the seed's: `promote` prints the task it spawned. */
  idsTarget?: string;
  presentation: Presentation;
};

/** A written seed's echo: its wire object and the signpost the styled views lead with. */
export function seedEcho(
  ports: Ports,
  seed: SeedView,
  signpost: string,
  presentation: Presentation,
): SeedEcho {
  return { presentation, seed, signpost, wire: ports.wire.seed(seed) };
}

const seedRecordsOf = (echo: Readonly<SeedEcho>): string =>
  `${okLine(echo.presentation, echo.signpost)}\n${renderSeedRecords(echo.seed, echo.presentation)}`;

/** `json` and `jsonl` of one seed print the same indented document, as the old CLI did. */
export const seedEchoViews = recordViews<SeedEcho>({
  ids: (echo) => echo.idsTarget ?? echo.seed.id,
  json: (echo) => prettyJson(echo.wire),
  records: seedRecordsOf,
});

/** The check-(c) per-row state word: what happened (or would happen) to the task. */
function resolutionState(alreadyRecorded: boolean, dryRun: boolean): string {
  if (alreadyRecorded) {
    return 'already recorded';
  }
  return dryRun ? 'would annotate' : 'annotated';
}

/**
 * The human triage report: a lede line with per-check counts, then the
 * untriaged, ready-to-resolve, and upstream-resolution sections. A report,
 * never a gate: it always renders, even when everything is clean.
 */
export function renderTriageReport(report: TriageReport, p: Presentation): string {
  const res = report.upstreamResolutions;
  const wrote = res.filter((r) => r.annotated).length;
  const already = res.filter((r) => r.alreadyRecorded).length;
  const wouldAnnotate = res.filter((r) => !r.alreadyRecorded && !r.annotated).length;
  const cParts = [
    report.dryRun ? `${String(wouldAnnotate)} would annotate` : `${String(wrote)} annotated`,
    `${String(already)} already recorded`,
  ];
  const parked = report.parked > 0 ? ` · ${String(report.parked)} parked` : '';
  const counts = `${countLine(report.untriaged.length, 'untriaged seed')}${parked} · ${String(report.readyToResolve.length)} ready to resolve · ${countLine(res.length, 'upstream resolution')} (${cParts.join(', ')})`;
  const lede = [
    bold(`triage ${report.board}`, p.plain),
    report.failures.length > 0
      ? `${counts} · ${countLine(report.failures.length, 'skipped')}`
      : counts,
  ];
  if (report.dryRun) {
    lede.push(
      p.plain
        ? '[dry run — no annotations written]'
        : dimmed('(dry run — no annotations written)', p.plain),
    );
  }
  const out: string[] = [lede.join('\n')];

  out.push('', bold(`untriaged (${String(report.untriaged.length)})`, p.plain));
  if (report.untriaged.length > 0) {
    out.push(...seedRows(report.untriaged, p));
  }
  out.push('', bold(`ready to resolve (${String(report.readyToResolve.length)})`, p.plain));
  if (report.readyToResolve.length > 0) {
    out.push(...seedRows(report.readyToResolve, p));
  }
  // Parked seeds are a reminder, never a decision: a count and where to look.
  if (report.parked > 0) {
    out.push(
      '',
      `${countLine(report.parked, 'parked seed')} — list them: mimir seeds -p ${report.board} --status parked`,
    );
  }
  out.push('', bold(`upstream resolutions (${String(res.length)})`, p.plain));
  const glyph = arrow(p.plain);
  for (const r of res) {
    // Read left to right: the settled upstream resolves INTO the task.
    const head = `${r.upstream} ${glyph} ${r.task} ${r.lifecycle}`;
    const reason = r.reason !== null && r.reason !== '' ? `: ${r.reason}` : '';
    const state = resolutionState(r.alreadyRecorded, report.dryRun);
    const unblock = r.blocked ? ` · blocked ${glyph} suggest: mimir unblock ${r.task}` : '';
    out.push(`${head}${reason}   ${state}${unblock}`);
  }
  // Skipped check-(c) tasks (corrupt anchor, read fault) are surfaced so the loss is visible.
  if (report.failures.length > 0) {
    out.push('', bold(`skipped (${String(report.failures.length)})`, p.plain));
    for (const f of report.failures) {
      out.push(`${f.task}: ${f.message}`);
    }
  }
  return out.join('\n');
}

/** The triage report, its wire object, and how the styled views render it. */
export type TriageValue = {
  report: TriageReport;
  wire: Record<string, unknown>;
  presentation: Presentation;
};

const triageRecords = (value: Readonly<TriageValue>): string =>
  renderTriageReport(value.report, value.presentation);

export const triageViews = recordViews<TriageValue>({
  // The actionable ids: the tasks with a settled upstream (check c).
  ids: (value) => value.report.upstreamResolutions.map((r) => r.task).join('\n'),
  json: (value) => prettyJson(value.wire),
  // The report is one heterogeneous object, so `jsonl` is `json` on a single line.
  jsonl: (value) => compactJson(value.wire),
  records: triageRecords,
});
