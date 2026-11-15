import type { DecisionView } from '@mimir/contract';
import type { Kysely } from 'kysely';

import { assertBoardActive } from '../archive-lock';
import type { DecisionStore } from '../decisions/store';
import { notFound, validation } from '../errors';
import type { StoreDialect } from './dialect';
import type { DB, Executor } from './schema';
import { createSqlWriter } from './writer';

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
  return {
    ...row,
    history: history.map(({ id: _id, decision_id: _decision, ...r }) => r),
    options: dialect.codecs.json.decode(row.options),
    tasks: tasks.map((r) => r.task),
  };
}

/** Persist the row, owned links, and append-only history inside the caller's transaction. */
export async function writeDecision(
  ex: Executor,
  dialect: StoreDialect,
  value: DecisionView,
  prior?: DecisionView,
): Promise<void> {
  const { tasks, history, ...row } = value;
  const encoded = { ...row, options: dialect.codecs.json.encode(row.options) };
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

export function createSqlDecisionStore(db: Kysely<DB>, dialect: StoreDialect): DecisionStore {
  return {
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
        const result = { ...value, id: `${value.project_key}-q${String(seq)}`, seq };
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
        const result = await apply(structuredClone(prior), createSqlWriter(tx, dialect));
        await writeDecision(tx, dialect, result, prior);
        return result;
      }),
  };
}

export async function exportDecisions(
  ex: Executor,
  dialect: StoreDialect,
): Promise<DecisionView[]> {
  const ids = await ex
    .selectFrom('decision')
    .select('id')
    .orderBy('project_key')
    .orderBy('seq')
    .execute();
  const result: DecisionView[] = [];
  for (const { id } of ids) {
    const value = await load(ex, dialect, id);
    if (value) {
      result.push(value);
    }
  }
  return result;
}
