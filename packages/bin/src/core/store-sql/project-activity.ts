import type { Executor } from './schema';

/**
 * Each project's most recent activity (MMR-494): the newest stamp across the
 * project row, its nodes, the transition log, annotations, seeds and their
 * history, and artifacts.
 *
 * One `UNION ALL` of per-source `MAX ... GROUP BY project` subselects, folded
 * by an outer `MAX ... GROUP BY`, so the cost is a fixed handful of scans however
 * many projects exist — never a query per project. Annotations and node-owned
 * transitions reach their project through `node`; seed history through `seed`.
 * Stamps are canonical ISO-8601 UTC strings (ADR 0029), so `MAX` over the text
 * is the chronological newest on both backends. The project row is one of the
 * sources, so every project appears and none reads null.
 */
export async function loadProjectActivity(ex: Executor): Promise<Map<string, string>> {
  const sources = ex
    .selectFrom('project')
    .select(['key as project_key', 'updated_at as at'])
    .unionAll(
      ex
        .selectFrom('node')
        .select(['project_key', (eb) => eb.fn.max<string>('updated_at').as('at')])
        .groupBy('project_key'),
    )
    .unionAll(
      ex
        .selectFrom('transition_log')
        .innerJoin('node', 'node.id', 'transition_log.node_id')
        .select([
          'node.project_key as project_key',
          (eb) => eb.fn.max<string>('transition_log.at').as('at'),
        ])
        .groupBy('node.project_key'),
    )
    .unionAll(
      ex
        .selectFrom('transition_log')
        .select(['project_key', (eb) => eb.fn.max<string>('at').as('at')])
        .where('project_key', 'is not', null)
        .groupBy('project_key')
        .$narrowType<{ project_key: string }>(),
    )
    .unionAll(
      ex
        .selectFrom('annotation')
        .innerJoin('node', 'node.id', 'annotation.node_id')
        .select([
          'node.project_key as project_key',
          (eb) => eb.fn.max<string>('annotation.created_at').as('at'),
        ])
        .groupBy('node.project_key'),
    )
    .unionAll(
      ex
        .selectFrom('seed')
        .select(['project_key', (eb) => eb.fn.max<string>('updated_at').as('at')])
        .groupBy('project_key'),
    )
    .unionAll(
      ex
        .selectFrom('seed_history')
        .innerJoin('seed', 'seed.id', 'seed_history.seed_id')
        .select([
          'seed.project_key as project_key',
          (eb) => eb.fn.max<string>('seed_history.at').as('at'),
        ])
        .groupBy('seed.project_key'),
    )
    .unionAll(
      ex
        .selectFrom('artifact')
        .select(['project_key', (eb) => eb.fn.max<string>('updated_at').as('at')])
        .groupBy('project_key'),
    );
  const rows = await ex
    .selectFrom(sources.as('source'))
    .select(['project_key', (eb) => eb.fn.max<string>('at').as('last_activity_at')])
    .groupBy('project_key')
    .execute();
  return new Map(rows.map((row) => [row.project_key, row.last_activity_at]));
}
