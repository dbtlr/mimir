import type { DecisionHistory, DecisionView } from '@mimir/contract';
import type { Kysely } from 'kysely';

import { assertBoardActive } from '../archive-lock';
import type { DecisionStore } from '../decisions/store';
import { invariant, notFound, validation } from '../errors';
import type { ExportedDecision } from '../export';
import { inLists, insertBatched } from './batch';
import type { StoreDialect } from './dialect';
import type { DB, Executor, DecisionTable } from './schema';
import { createSqlWriter } from './writer';

/**
 * The stored options as an export carries them: decoded, or the raw stored
 * text when it does not decode, so a backup of a damaged row loses nothing and
 * import refuses it by shape.
 */
function exportedOptionsOf(row: DecisionTable['options'], dialect: StoreDialect): string[] {
  try {
    return dialect.codecs.json.decode(row);
  } catch {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- damaged backups retain raw values for repair
    return row as unknown as string[];
  }
}

/**
 * The stored options as a verb or read uses them. A row whose options are not
 * a list of strings is damaged: refuse it, so no write commits through it and
 * no read renders it.
 */
function loadedOptionsOf(
  id: string,
  row: DecisionTable['options'],
  dialect: StoreDialect,
): string[] {
  let options: unknown;
  try {
    options = dialect.codecs.json.decode(row);
  } catch {
    options = undefined;
  }
  if (!Array.isArray(options) || !options.every((o) => typeof o === 'string')) {
    throw invariant(
      `${id} has damaged options and cannot be read or changed`,
      'run `mimir doctor` to find it, then repair the row from a backup',
    );
  }
  return options;
}

function exportedDetailsOf(
  row: DecisionTable['option_details'],
  dialect: StoreDialect,
): ExportedDecision['option_details'] {
  if (row === null) {
    return null;
  }
  try {
    return dialect.codecs.json.decode(row);
  } catch {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- preserve damaged raw backups
    return row as unknown as ExportedDecision['option_details'];
  }
}

function loadedDetailsOf(
  row: DecisionTable,
  dialect: StoreDialect,
): DecisionView['option_details'] {
  const options = loadedOptionsOf(row.id, row.options, dialect);
  if (row.option_details === null) {
    return options.map(() => null);
  }
  const value: unknown = exportedDetailsOf(row.option_details, dialect);
  if (
    !Array.isArray(value) ||
    value.length !== options.length ||
    !value.every(
      (detail) => detail === null || (typeof detail === 'string' && detail.trim() !== ''),
    ) ||
    value.every((detail) => detail === null)
  ) {
    throw invariant(
      `${row.id} has damaged option_details and cannot be read or changed`,
      'run `mimir doctor` to find it, then repair the row from a backup',
    );
  }
  return value;
}

function encodedDetailsOf(details: ExportedDecision['option_details'], dialect: StoreDialect) {
  return details === null || details.every((d) => d === null)
    ? null
    : dialect.codecs.json.encode(details);
}

/** Normalize echoes and loaded rows to table column order. */
function toStored(d: DecisionView): DecisionView;
function toStored(d: ExportedDecision): ExportedDecision;
function toStored(d: ExportedDecision): ExportedDecision {
  /* eslint-disable sort-keys -- SQL column order is the public echo order. */
  return {
    id: d.id,
    project_key: d.project_key,
    seq: d.seq,
    question: d.question,
    options: d.options,
    option_details: d.option_details,
    recommended: d.recommended,
    taken: d.taken,
    class: d.class,
    why: d.why,
    delivery: d.delivery,
    lifecycle: d.lifecycle,
    overturn_option: d.overturn_option,
    outcome_note: d.outcome_note,
    created_at: d.created_at,
    updated_at: d.updated_at,
    tasks: d.tasks,
    history: d.history.map((h): DecisionHistory => ({
      kind: h.kind,
      from_value: h.from_value,
      to_value: h.to_value,
      reason: h.reason,
      task: h.task,
      at: h.at,
    })),
  };
  /* eslint-enable sort-keys */
}

async function load(
  ex: Executor,
  dialect: StoreDialect,
  id: string,
): Promise<DecisionView | undefined> {
  const row = await ex.selectFrom('decision').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) {
    return undefined;
  }
  const tasks = await ex
    .selectFrom('decision_task')
    .leftJoin('node', 'node.id', 'decision_task.task')
    .select('task')
    .where('decision_id', '=', id)
    .orderBy('node.seq')
    .execute();
  const history = await ex
    .selectFrom('decision_history')
    .selectAll()
    .where('decision_id', '=', id)
    .orderBy('id')
    .execute();
  return toStored({
    ...row,
    history: history.map(({ id: _id, decision_id: _decision, ...r }) => r),
    option_details: loadedDetailsOf(row, dialect),
    options: loadedOptionsOf(id, row.options, dialect),
    tasks: tasks.map((r) => r.task),
  });
}

/** Persist the row, owned links, and append-only history inside the caller's transaction. */
export async function writeDecision(
  ex: Executor,
  dialect: StoreDialect,
  value: DecisionView,
  prior?: DecisionView,
): Promise<void> {
  const { tasks, history, ...row } = value;
  const encoded = {
    ...row,
    option_details: encodedDetailsOf(row.option_details, dialect),
    options: dialect.codecs.json.encode(row.options),
  };
  if (prior) {
    await ex.updateTable('decision').set(encoded).where('id', '=', value.id).execute();
  } else {
    await ex.insertInto('decision').values(encoded).execute();
  }
  for (const task of prior?.tasks ?? []) {
    if (!tasks.includes(task)) {
      await ex
        .deleteFrom('decision_task')
        .where('decision_id', '=', value.id)
        .where('task', '=', task)
        .execute();
    }
  }
  for (const task of tasks) {
    if (!prior?.tasks.includes(task)) {
      await ex.insertInto('decision_task').values({ decision_id: value.id, task }).execute();
    }
  }
  for (const entry of history.slice(prior?.history.length ?? 0)) {
    await ex
      .insertInto('decision_history')
      .values({ ...entry, decision_id: value.id })
      .execute();
  }
}

/**
 * Write imported decisions with their links and history, one statement per
 * chunk rather than one round trip per row (MMR-380's batching rule). History
 * rows are inserted in document order, so their ids keep it.
 */
export async function insertExportedDecisions(
  ex: Executor,
  dialect: StoreDialect,
  decisions: readonly ExportedDecision[],
): Promise<void> {
  const rows = decisions.map(({ tasks: _tasks, history: _history, ...row }) => ({
    ...row,
    option_details: encodedDetailsOf(row.option_details, dialect),
    options: dialect.codecs.json.encode(row.options),
  }));
  await insertBatched(rows, dialect.maxParameters, (chunk) =>
    ex.insertInto('decision').values(chunk).execute(),
  );
  const links = decisions.flatMap((d) => d.tasks.map((task) => ({ decision_id: d.id, task })));
  await insertBatched(links, dialect.maxParameters, (chunk) =>
    ex.insertInto('decision_task').values(chunk).execute(),
  );
  const history = decisions.flatMap((d) =>
    d.history.map((entry) => ({ ...entry, decision_id: d.id })),
  );
  await insertBatched(history, dialect.maxParameters, (chunk) =>
    ex.insertInto('decision_history').values(chunk).execute(),
  );
}

export function createSqlDecisionStore(db: Kysely<DB>, dialect: StoreDialect): DecisionStore {
  return {
    countProvisional: async (project) => {
      const row = await db
        .selectFrom('decision')
        .select((eb) => eb.fn.countAll<string | number>().as('count'))
        .where('project_key', '=', project)
        .where('lifecycle', '=', 'provisional')
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
    create: (prepare) =>
      dialect.write(db, async (tx) => {
        const value = await prepare(createSqlWriter(tx, dialect));
        const project = await tx
          .selectFrom('project')
          .selectAll()
          .where('key', '=', value.project_key)
          .executeTakeFirst();
        assertBoardActive(project, value.project_key);
        const seq = (project?.last_decision_seq ?? 0) + 1;
        if (seq > 2147483647) {
          throw validation('decision ids exhausted');
        }
        const result = toStored({ ...value, id: `${value.project_key}-q${String(seq)}`, seq });
        await tx
          .updateTable('project')
          .set({ last_decision_seq: seq })
          .where('key', '=', value.project_key)
          .execute();
        await writeDecision(tx, dialect, result);
        return result;
      }),
    forTask: (id) =>
      db
        .selectFrom('decision_task')
        .innerJoin('decision', 'decision.id', 'decision_task.decision_id')
        .select(['decision.id', 'decision.lifecycle'])
        .where('task', '=', id)
        .orderBy('decision.seq')
        .execute(),
    list: (input) =>
      dialect.snapshot(db, async (tx) => {
        let query = tx.selectFrom('decision').selectAll().where('project_key', '=', input.project);
        if (input.status !== undefined && input.status !== 'all') {
          query = query.where('lifecycle', '=', input.status);
        }
        if (input.classes?.length) {
          query = query.where('class', 'in', input.classes);
        }
        if (input.delivery !== undefined) {
          query = query.where('delivery', '=', input.delivery);
        }
        if (input.linked) {
          query = query.where((eb) =>
            eb.exists(
              eb
                .selectFrom('decision_task')
                .innerJoin('node', 'node.id', 'decision_task.task')
                .select('decision_task.decision_id')
                .whereRef('decision_task.decision_id', '=', 'decision.id')
                .where('node.lifecycle', '!=', 'abandoned'),
            ),
          );
        }
        return hydrateDecisions(tx, dialect, await query.orderBy('seq').execute(), false);
      }),
    listProvisional: () =>
      dialect.snapshot(db, async (tx) => {
        const rows = await tx
          .selectFrom('decision')
          .innerJoin('project', 'project.key', 'decision.project_key')
          .selectAll('decision')
          .where('decision.lifecycle', '=', 'provisional')
          .where('project.archived_at', 'is', null)
          .execute();
        const links = await taskLinksOf(
          tx,
          dialect,
          rows.map((r) => r.id),
        );
        return rows.map((row) => {
          const { history: _history, ...listed } = toStored({
            ...row,
            history: [],
            option_details: loadedDetailsOf(row, dialect),
            options: loadedOptionsOf(row.id, row.options, dialect),
            tasks: links.get(row.id) ?? [],
          });
          return listed;
        });
      }),
    load: (id) => dialect.snapshot(db, (tx) => load(tx, dialect, id)),
    transact: (id, apply) =>
      dialect.write(db, async (tx) => {
        const prior = await load(tx, dialect, id);
        if (!prior) {
          throw notFound(`${id} doesn't exist`);
        }
        assertBoardActive(
          await createSqlWriter(tx, dialect).loadProject(prior.project_key),
          prior.project_key,
        );
        if (prior.lifecycle !== 'provisional') {
          throw validation(
            `${id} is ${prior.lifecycle}; this decision refuses every write`,
            'record a new decision with decide',
          );
        }
        const result = toStored(await apply(structuredClone(prior), createSqlWriter(tx, dialect)));
        await writeDecision(tx, dialect, result, prior);
        return result;
      }),
  };
}

export async function exportDecisions(
  ex: Executor,
  dialect: StoreDialect,
): Promise<ExportedDecision[]> {
  const rows = await ex
    .selectFrom('decision')
    .selectAll()
    .orderBy('project_key')
    .orderBy('seq')
    .execute();
  return hydrateDecisions(ex, dialect, rows, true);
}

/** Each decision's linked task ids in task order, read in bounded batches. */
async function taskLinksOf(
  ex: Executor,
  dialect: StoreDialect,
  ids: string[],
): Promise<Map<string, string[]>> {
  const links = new Map<string, string[]>();
  for (const chunk of inLists(ids, dialect.maxParameters)) {
    const tasks = await ex
      .selectFrom('decision_task')
      .leftJoin('node', 'node.id', 'decision_task.task')
      .select(['decision_id', 'task'])
      .where('decision_id', 'in', chunk)
      .orderBy('node.seq')
      .execute();
    for (const t of tasks) {
      const owned = links.get(t.decision_id) ?? [];
      owned.push(t.task);
      links.set(t.decision_id, owned);
    }
  }
  return links;
}

/** Hydrate only the selected rows, with bounded batches for owned links and history. */
function hydrateDecisions(
  ex: Executor,
  dialect: StoreDialect,
  rows: DecisionTable[],
  exporting: false,
): Promise<DecisionView[]>;
function hydrateDecisions(
  ex: Executor,
  dialect: StoreDialect,
  rows: DecisionTable[],
  exporting: true,
): Promise<ExportedDecision[]>;
async function hydrateDecisions(
  ex: Executor,
  dialect: StoreDialect,
  rows: DecisionTable[],
  exporting: boolean,
): Promise<ExportedDecision[]> {
  const links = await taskLinksOf(
    ex,
    dialect,
    rows.map((r) => r.id),
  );
  const histories = new Map<string, DecisionHistory[]>();
  for (const chunk of inLists(
    rows.map((r) => r.id),
    dialect.maxParameters,
  )) {
    const history = await ex
      .selectFrom('decision_history')
      .selectAll()
      .where('decision_id', 'in', chunk)
      .orderBy('id')
      .execute();
    for (const { id: _id, decision_id, ...h } of history) {
      const owned = histories.get(decision_id) ?? [];
      owned.push(h);
      histories.set(decision_id, owned);
    }
  }
  return rows.map((row) =>
    toStored({
      ...row,
      history: histories.get(row.id) ?? [],
      option_details: exporting
        ? exportedDetailsOf(row.option_details, dialect)
        : loadedDetailsOf(row, dialect),
      options: exporting
        ? exportedOptionsOf(row.options, dialect)
        : loadedOptionsOf(row.id, row.options, dialect),
      tasks: links.get(row.id) ?? [],
    }),
  );
}
