// Shared test fixtures module, not a test body.
// oxlint-disable vitest/require-hook
import type { ReviewReport } from '../api/view-queries';
import { engineReview, needsYouRow, stripRow } from './views-fixtures';

/*
 * Needs-you rows and the review report that ranks them, for the Needs you
 * deck's tests (ADR 0019, MMR-721 refinement): the report's queue walks the
 * rows in the order given, and its groups hold them by project.
 */

export type Row = ReviewReport['needsYou'][number]['rows'][number];
type DecisionRow = Extract<Row, { kind: 'decision' }>;
type DeliveryRow = Extract<Row, { kind: 'delivery' }>;

export const T0 = new Date('2026-11-23T08:00:00Z');
export const hoursAgo = (hours: number) => new Date(T0.getTime() - hours * 3_600_000);

export function decision(
  id: string,
  {
    delivery = null,
    tasks = [],
    at = T0,
  }: { delivery?: string | null; tasks?: string[]; at?: Date },
): DecisionRow {
  const project = id.slice(0, id.indexOf('-'));
  return {
    decision: {
      class: 'product',
      created_at: at,
      delivery,
      id,
      lifecycle: 'provisional',
      option_details: [null, null],
      options: ['Keep', 'Remove'],
      outcome_note: null,
      overturn_option: null,
      project_key: project,
      question: `Question ${id}?`,
      recommended: 1,
      seq: Number(id.slice(id.indexOf('-q') + 2)),
      taken: 1,
      tasks,
      updated_at: at,
      why: null,
    },
    kind: 'decision',
    workBuiltOnIt: tasks.length > 0,
  };
}

export function stopped(
  id: string,
  { reason = null, at = T0 }: { reason?: string | null; at?: Date } = {},
): DeliveryRow {
  const project = id.slice(0, id.indexOf('-'));
  return {
    delivery: {
      hold_reason: reason,
      id,
      lifecycle: 'running',
      phase: `${project}-2`,
      project,
      seq: Number(id.slice(id.indexOf('-d') + 2)),
      title: `Delivery ${id}`,
      updated_at: at,
    },
    kind: 'delivery',
  };
}

const idOf = (row: Row): string => {
  if (row.kind === 'task') {
    return row.task.id;
  }
  return row.kind === 'decision' ? row.decision.id : row.delivery.id;
};
const projectOf = (row: Row) => idOf(row).slice(0, idOf(row).indexOf('-'));

/** A review report whose queue walks `rows` in the order given, grouped by project as the report groups them. */
export function report(
  rows: Row[],
  {
    names = { FLT: 'Fleet', MMR: 'Mimir' },
    facts = { bundles: [], deliveries: [] },
  }: { names?: Record<string, string>; facts?: ReviewReport['needsYouFacts'] } = {},
): ReviewReport {
  const keys = [...new Set(rows.map(projectOf))];
  return engineReview({
    needsYou: keys.map((key) => ({
      project: { key, name: names[key] ?? key },
      rows: rows.filter((row) => projectOf(row) === key),
    })),
    needsYouFacts: facts,
    projects: Object.entries(names).map(([key, name]) => stripRow({ key, name })),
    queue: rows.map((row) => ({ id: idOf(row), kind: row.kind })),
  });
}

export const question = (id: string, text: string | null = 'Where does the pin live?') =>
  needsYouRow(
    { id, status: 'ready', title: `Task ${id}`, updatedAt: hoursAgo(2) },
    'needs_answers',
    {
      question: text,
    },
  );
export const blocked = (id: string, holdReason: string | null = 'Approve the account.') =>
  needsYouRow(
    {
      hold: 'blocked',
      holdReason,
      id,
      status: 'blocked',
      title: `Task ${id}`,
      updatedAt: hoursAgo(3),
    },
    'blocked',
  );
