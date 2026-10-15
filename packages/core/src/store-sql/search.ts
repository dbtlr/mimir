// Kysely's CASE builder names its branch `.then`; nothing here is a promise chain.
/* oxlint-disable promise/prefer-await-to-then */
import type { Lifecycle, SearchKind, SearchLink, SeedLifecycle } from '@mimir/contract';
import type { ExpressionBuilder, SqlBool } from 'kysely';
import { sql } from 'kysely';

import { parseIdentity } from '../ids';
import type {
  MatchTier,
  SearchRecord,
  SearchStore,
  SuffixClass,
  TextHit,
  TextSearch,
} from '../search/store';
import { inLists } from './batch';
import type { StoreDialect } from './dialect';
import type { Executor } from './schema';

/**
 * The SQL store's search slice (MMR-447). Every read starts from one
 * `catalog` of the searchable records across active projects — nodes,
 * projects, seeds, and artifacts in one column shape — so the text search,
 * the ID lookups, and the link expansion all see the same records and the same
 * `finished` reading.
 *
 * Plain SQL over the tables, with no search index: the scan is small, and an
 * index (FTS5, `tsvector`, `pg_trgm`) would cost a migration on each backend.
 */

const TERMINAL_LIFECYCLES: readonly Lifecycle[] = ['done', 'abandoned'];
const TERMINAL_SEED_LIFECYCLES: readonly SeedLifecycle[] = ['resolved', 'rejected'];

const SUFFIX_KINDS: Record<SuffixClass, SearchKind[]> = {
  artifact: ['artifact'],
  node: ['initiative', 'phase', 'task'],
  seed: ['seed'],
};

/** The order a doubly-linked record's label is chosen in. */
const LINK_ORDER: readonly SearchLink[] = [
  'parent',
  'child',
  'depends_on',
  'blocks',
  'artifact',
  'upstream',
  'spawned',
  'downstream',
  'attached',
];

/**
 * The catalog CTEs. A container is finished when it is not open-ended, has at
 * least one task beneath it, and every such task is terminal — the tasks found
 * by walking the tree (`tree` pairs every node with each of its ancestors), so
 * a phase under an initiative counts toward the initiative.
 */
function catalog(ex: Executor, dialect: StoreDialect) {
  return ex
    .withRecursive('tree(ancestor, member)', (db) =>
      db
        .selectFrom('node')
        .where('node.parent_id', 'is not', null)
        .select(['node.parent_id as ancestor', 'node.id as member'])
        .unionAll((db2) =>
          db2
            .selectFrom('node')
            .innerJoin('tree', 'tree.member', 'node.parent_id')
            .select(['tree.ancestor', 'node.id as member']),
        ),
    )
    .with('settled', (db) =>
      db
        .selectFrom('tree')
        .innerJoin('node', 'node.id', 'tree.member')
        .where('node.type', '=', 'task')
        .groupBy('tree.ancestor')
        .select((eb) => [
          'tree.ancestor as id',
          eb.fn
            .min(
              eb
                .case()
                .when('node.lifecycle', 'in', TERMINAL_LIFECYCLES)
                .then(eb.lit(1))
                .else(eb.lit(0))
                .end(),
            )
            .as('all_terminal'),
        ]),
    )
    .with('catalog', (db) =>
      db
        .selectFrom('node')
        .innerJoin('project', 'project.key', 'node.project_key')
        .leftJoin('settled', 'settled.id', 'node.id')
        .where('project.archived_at', 'is', null)
        .select((eb) => [
          eb.ref('node.type').$castTo<SearchKind>().as('kind'),
          'node.id as id',
          'node.project_key as project',
          eb.ref('node.seq').$castTo<number | null>().as('seq'),
          'node.title as title',
          'node.description as description',
          'node.updated_at as updated_at',
          eb.ref('node.lifecycle').$castTo<Lifecycle | SeedLifecycle | null>().as('lifecycle'),
          eb
            .case()
            .when('node.type', '=', 'task')
            .then(
              eb
                .case()
                .when('node.lifecycle', 'in', TERMINAL_LIFECYCLES)
                .then(eb.lit(1))
                .else(eb.lit(0))
                .end(),
            )
            .when('node.open_ended', '=', dialect.codecs.bool.encode(true))
            .then(eb.lit(0))
            .when('settled.all_terminal', '=', eb.lit(1))
            .then(eb.lit(1))
            .else(eb.lit(0))
            .end()
            .as('finished'),
        ])
        .unionAll(
          db
            .selectFrom('project')
            .where('project.archived_at', 'is', null)
            .select((eb) => [
              sql.lit('project').$castTo<SearchKind>().as('kind'),
              'project.key as id',
              'project.key as project',
              sql.lit(null).$castTo<number | null>().as('seq'),
              'project.name as title',
              'project.description as description',
              'project.updated_at as updated_at',
              sql.lit(null).$castTo<Lifecycle | SeedLifecycle | null>().as('lifecycle'),
              eb.lit(0).as('finished'),
            ]),
        )
        .unionAll(
          db
            .selectFrom('seed')
            .innerJoin('project', 'project.key', 'seed.project_key')
            .where('project.archived_at', 'is', null)
            .select((eb) => [
              sql.lit('seed').$castTo<SearchKind>().as('kind'),
              'seed.id as id',
              'seed.project_key as project',
              eb.ref('seed.seq').$castTo<number | null>().as('seq'),
              'seed.title as title',
              'seed.description as description',
              'seed.updated_at as updated_at',
              eb.ref('seed.lifecycle').$castTo<Lifecycle | SeedLifecycle | null>().as('lifecycle'),
              eb
                .case()
                .when('seed.lifecycle', 'in', TERMINAL_SEED_LIFECYCLES)
                .then(eb.lit(1))
                .else(eb.lit(0))
                .end()
                .as('finished'),
            ]),
        )
        .unionAll(
          db
            .selectFrom('artifact')
            .innerJoin('project', 'project.key', 'artifact.project_key')
            .where('project.archived_at', 'is', null)
            .select((eb) => [
              sql.lit('artifact').$castTo<SearchKind>().as('kind'),
              'artifact.id as id',
              'artifact.project_key as project',
              eb.ref('artifact.seq').$castTo<number | null>().as('seq'),
              'artifact.title as title',
              'artifact.summary as description',
              'artifact.updated_at as updated_at',
              sql.lit(null).$castTo<Lifecycle | SeedLifecycle | null>().as('lifecycle'),
              eb.lit(0).as('finished'),
            ]),
        ),
    );
}

type CatalogRow = {
  kind: SearchKind;
  id: string;
  project: string;
  title: string;
  updated_at: string;
  lifecycle: Lifecycle | SeedLifecycle | null;
  // A driver may hand an integer back as a string (node-postgres) or a number.
  finished: number | string;
};

function toRecord(row: CatalogRow): SearchRecord {
  return {
    finished: Number(row.finished) === 1,
    id: row.id,
    kind: row.kind,
    lifecycle: row.lifecycle,
    project: row.project,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

const RECORD_COLUMNS = [
  'kind',
  'id',
  'project',
  'title',
  'updated_at',
  'lifecycle',
  'finished',
] as const;

/** A driver may hand the tier back as a number or a numeric string; the query never returns a null one. */
function toTier(value: number | string | null): MatchTier {
  const tier = Number(value);
  if (tier === 1 || tier === 2) {
    return tier;
  }
  return 3;
}

/** `!` escapes LIKE's wildcards (and itself) in a user's term. */
function escapeLike(text: string): string {
  return text.replaceAll(/[!%_]/g, '!$&');
}

/** `seed` → `%s%e%e%d%`: the term's characters in order, anything between. */
function subsequencePattern(term: string): string {
  // Code points, not graphemes: LIKE's `%` and `_` match code points too.
  // oxlint-disable-next-line typescript/no-misused-spread
  return `%${[...term].map(escapeLike).join('%')}%`;
}

type CatalogBuilder = ExpressionBuilder<
  { catalog: CatalogRow & { description: string | null } },
  'catalog'
>;

function titleLike(eb: CatalogBuilder, pattern: string) {
  return sql<SqlBool>`lower(${eb.ref('title')}) like ${pattern} escape '!'`;
}

/**
 * The two passes of a text search. The precise pass finds titles holding every
 * term (tier 1) and descriptions holding every word whole (tier 3); the fuzzy
 * pass finds titles holding every term as a subsequence (tier 2) and runs only
 * when the precise pass finds nothing. Over long titles a subsequence matches
 * far more than it means, so it never outranks a precise hit.
 */
type Pass = 'precise' | 'fuzzy';

function tierOf(eb: CatalogBuilder, query: TextSearch, dialect: StoreDialect, pass: Pass) {
  if (pass === 'fuzzy') {
    return eb
      .case()
      .when(eb.and(query.terms.map((term) => titleLike(eb, subsequencePattern(term)))))
      .then(eb.lit<MatchTier>(2))
      .end();
  }
  const tier = eb
    .case()
    .when(eb.and(query.terms.map((term) => titleLike(eb, `%${escapeLike(term)}%`))))
    .then(eb.lit<MatchTier>(1));
  if (query.words.length === 0) {
    return tier.end();
  }
  return tier
    .when(eb.and(query.words.map((word) => dialect.wholeWord(eb.ref('description'), word))))
    .then(eb.lit<MatchTier>(3))
    .end();
}

export function createSqlSearchStore(db: Executor, dialect: StoreDialect): SearchStore {
  const ranked = async (query: TextSearch, pass: Pass) => {
    let hits = catalog(db, dialect)
      .with('ranked', (cte) =>
        cte
          .selectFrom('catalog')
          .selectAll()
          .select((eb) => tierOf(eb, query, dialect, pass).as('tier')),
      )
      .selectFrom('ranked')
      .where('tier', 'is not', null)
      .select((eb) => [
        ...RECORD_COLUMNS,
        'description',
        'tier',
        eb.fn.countAll().over().as('total'),
      ])
      .orderBy('tier');
    if (query.project !== undefined) {
      const project = query.project;
      hits = hits.orderBy((eb) =>
        eb.case().when('project', '=', project).then(eb.lit(0)).else(eb.lit(1)).end(),
      );
    }
    const rows = await hits
      .orderBy('finished')
      .orderBy('updated_at', 'desc')
      .orderBy('id')
      .limit(query.limit)
      .execute();
    const items: TextHit[] = rows.map((row) => ({
      ...toRecord(row),
      description: row.description,
      tier: toTier(row.tier),
    }));
    return { items, total: Number(rows[0]?.total ?? 0) };
  };

  const text: SearchStore['text'] = async (query) => {
    const precise = await ranked(query, 'precise');
    return precise.total > 0 ? precise : ranked(query, 'fuzzy');
  };

  const records: SearchStore['records'] = async (ids) => {
    const found: SearchRecord[] = [];
    for (const chunk of inLists([...new Set(ids)], dialect.maxParameters)) {
      const rows = await catalog(db, dialect)
        .selectFrom('catalog')
        .where('id', 'in', chunk)
        .select(RECORD_COLUMNS)
        .execute();
      found.push(...rows.map(toRecord));
    }
    return found;
  };

  const bySuffix: SearchStore['bySuffix'] = async (suffix) => {
    const rows = await catalog(db, dialect)
      .selectFrom('catalog')
      .where('seq', '=', suffix.seq)
      .where('kind', 'in', SUFFIX_KINDS[suffix.class])
      .select(RECORD_COLUMNS)
      .orderBy('project')
      .execute();
    return rows.map(toRecord);
  };

  const links: SearchStore['links'] = async (id) => {
    const found = await linkedIds(db, dialect, id);
    const labelled = new Map<string, SearchLink>();
    for (const link of LINK_ORDER) {
      for (const linked of found[link] ?? []) {
        if (linked !== id && !labelled.has(linked)) {
          labelled.set(linked, link);
        }
      }
    }
    return [...labelled].map(([linked, link]) => ({ id: linked, link }));
  };

  return { bySuffix, links, records, text };
}

/** The ids linked to one record, by label — straight from the link columns and tables. */
async function linkedIds(
  db: Executor,
  dialect: StoreDialect,
  id: string,
): Promise<Partial<Record<SearchLink, string[]>>> {
  const identity = parseIdentity(id);
  switch (identity?.kind) {
    case 'project': {
      const children = await db
        .selectFrom('node')
        .where('project_key', '=', id)
        .where('parent_id', 'is', null)
        .select('id')
        .execute();
      return { child: children.map((row) => row.id) };
    }
    case 'node': {
      const node = await db
        .selectFrom('node')
        .where('id', '=', id)
        .select(['parent_id', 'project_key', 'upstream'])
        .executeTakeFirst();
      if (node === undefined) {
        return {};
      }
      const [children, prerequisites, dependents, artifacts] = await Promise.all([
        db.selectFrom('node').where('parent_id', '=', id).select('id').execute(),
        db
          .selectFrom('dependency')
          .where('node_id', '=', id)
          .select('depends_on_node_id as id')
          .execute(),
        db
          .selectFrom('dependency')
          .where('depends_on_node_id', '=', id)
          .select('node_id as id')
          .execute(),
        db
          .selectFrom('artifact_link')
          .where('node_id', '=', id)
          .select('artifact_id as id')
          .execute(),
      ]);
      return {
        artifact: artifacts.map((row) => row.id),
        blocks: dependents.map((row) => row.id),
        child: children.map((row) => row.id),
        depends_on: prerequisites.map((row) => row.id),
        // A root's parent is its project.
        parent: [node.parent_id ?? node.project_key],
        upstream: node.upstream === null ? [] : [node.upstream],
      };
    }
    case 'seed': {
      const [seed, downstream] = await Promise.all([
        db.selectFrom('seed').where('id', '=', id).select('spawned').executeTakeFirst(),
        db.selectFrom('node').where('upstream', '=', id).select('id').execute(),
      ]);
      return {
        downstream: downstream.map((row) => row.id),
        spawned: seed === undefined ? [] : dialect.codecs.list.decode(seed.spawned),
      };
    }
    case 'artifact': {
      const attached = await db
        .selectFrom('artifact_link')
        .where('artifact_id', '=', id)
        .select('node_id as id')
        .execute();
      return { attached: attached.map((row) => row.id) };
    }
    default: {
      return {};
    }
  }
}
