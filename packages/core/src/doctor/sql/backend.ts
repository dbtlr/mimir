/**
 * The SQL backends' implementation of the neutral doctor contract (ADR 0030
 * Decision 6, ADR 0032) — one doctor over the shared SQL store, for Postgres
 * and SQLite alike. Every check reads rows:
 * one query whose result set IS the finding list.
 *
 * Doctor only reports. The constraints are the validator: a foreign key, a
 * primary key, and a `CHECK` over each closed vocabulary make nearly every
 * corrupt state unrepresentable. What remains is
 * the short list below — the referential checks catch a dropped or disabled
 * constraint, i.e. a hand edit at the database prompt, not a failed import (a
 * deferred foreign key still fails at commit, and the whole import runs in one
 * transaction) — and a state a human produced by hand is a state a human
 * resolves by hand.
 *
 * Connectivity is not a finding. A query that cannot reach the database throws,
 * and doctor's own nonzero exit reports it: an unreachable store has no record
 * health to report, clean or otherwise.
 */
import type { DeliveryLifecycle } from '@mimir/contract';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { checklistFaults } from '../../checklist/validate';
import { decisionFaults } from '../../decisions/validate';
import { deliveryReferenceFault } from '../../deliveries/membership';
import { parseIdentity } from '../../ids';
import type { Node } from '../../model';
import { inLists } from '../../store-sql/batch';
import { exportDecisions } from '../../store-sql/decisions';
import type { StoreDialect } from '../../store-sql/dialect';
import { readSchemaVersion, SCHEMA_VERSION } from '../../store-sql/migrator';
import type { DB } from '../../store-sql/schema';
import { isCanonicalInstant, now } from '../../time';
import type { DoctorBackend, DoctorDiagnosis, DoctorFinding, DoctorScopeMatch } from '../contract';
import { isUnscoped } from '../contract';
import type { DoctorFacet } from '../facet';
import { withFindings } from '../facet';

/**
 * The scope key store-level findings carry. A schema version belongs to the
 * database, not to a project, so it owns a scope word no project key can be
 * (keys are two to four uppercase letters).
 */
const STORE_SCOPE = 'store';

/** The closed code vocabulary this backend reports. */
type SqlCheck =
  | 'counter-behind'
  | 'invalid-checklist-item'
  | 'invalid-delivery'
  | 'invalid-decision'
  | 'dangling-edge'
  | 'dangling-parent'
  | 'malformed-timestamp'
  | 'orphan-link'
  | 'schema-version';

/**
 * Build one finding. `locator` is `<table>/<key>` rather than a path: there is
 * no file behind a row, and the table plus the key is what a human needs to
 * reach it. `code` and `check` are the same word — each check here reports
 * exactly one kind of problem, so a separate code would be a second name for
 * one thing.
 */
function finding(input: {
  check: SqlCheck;
  evidence: Readonly<Record<string, unknown>>;
  locator: string;
  message: string;
  scopeKey?: string;
  severity?: 'error' | 'warn';
  stem: string;
  where: string;
}): DoctorFinding {
  return {
    check: input.check,
    code: input.check,
    evidence: input.evidence,
    locator: input.locator,
    message: input.message,
    node: input.stem,
    scopeKey: input.scopeKey ?? parseIdentity(input.stem)?.key ?? input.stem,
    severity: input.severity ?? 'error',
    stem: input.stem,
    where: input.where,
  };
}

/**
 * The stored schema version against the one this binary reads.
 *
 * Unreachable through the composition root — the Postgres arm's
 * `assertSchemaCurrent` refuses the connection before a store exists, and the
 * SQLite arm migrates on open — but reported all the same, because a
 * caller that holds a handle directly (a test's) is
 * owed the answer rather than an empty diagnosis.
 */
async function checkSchemaVersion(db: Kysely<DB>, dialect: StoreDialect): Promise<DoctorFinding[]> {
  const version = await readSchemaVersion(db, dialect);
  if (version === SCHEMA_VERSION) {
    return [];
  }
  const stored = version === null ? 'absent' : String(version);
  const remedy = schemaRemedy(version, dialect);
  return [
    finding({
      check: 'schema-version',
      evidence: { binary: SCHEMA_VERSION, stored: version },
      locator: 'schema_version',
      message: `the store schema is ${stored === 'absent' ? 'absent' : `version ${stored}`}; this binary reads version ${String(SCHEMA_VERSION)} — ${remedy}`,
      scopeKey: STORE_SCOPE,
      stem: STORE_SCOPE,
      where: 'schema_version · version',
    }),
  ];
}

/** What the operator does about a stored schema other than this binary's. */
function schemaRemedy(version: number | null, dialect: StoreDialect): string {
  if (version === null) {
    return dialect.schemaRemedy.missing;
  }
  if (version < SCHEMA_VERSION) {
    return dialect.schemaRemedy.behind;
  }
  return 'upgrade the binary; a newer schema is never downgraded';
}

/**
 * A node whose `parent_id` names no node row. The parent foreign key is
 * deferred (a self-reference an import satisfies only once the whole tree has
 * landed), but a deferred constraint still fails at commit, and the whole
 * import runs in one transaction, so a failed import writes nothing. This
 * check exists for the constraint itself being dropped or disabled — a hand
 * edit at the `psql` prompt — not for an import gone wrong.
 */
async function checkDanglingParent(db: Kysely<DB>): Promise<DoctorFinding[]> {
  const rows = await db
    .selectFrom('node as n')
    .leftJoin('node as p', 'p.id', 'n.parent_id')
    .where('n.parent_id', 'is not', null)
    .where('p.id', 'is', null)
    .select(['n.id as id', 'n.parent_id as parent_id'])
    .orderBy('n.id')
    .execute();
  return rows.map((row) =>
    finding({
      check: 'dangling-parent',
      evidence: { parent_id: row.parent_id, value: row.parent_id },
      locator: `node/${row.id}`,
      message: `${row.id} names parent ${String(row.parent_id)}, which no node row holds`,
      stem: row.id,
      where: 'node · parent_id',
    }),
  );
}

/** A dependency edge whose either end names no node row. */
async function checkDanglingEdge(db: Kysely<DB>): Promise<DoctorFinding[]> {
  const rows = await db
    .selectFrom('dependency as d')
    .leftJoin('node as a', 'a.id', 'd.node_id')
    .leftJoin('node as b', 'b.id', 'd.depends_on_node_id')
    .where((eb) => eb.or([eb('a.id', 'is', null), eb('b.id', 'is', null)]))
    .select((eb) => [
      'd.node_id as node_id',
      'd.depends_on_node_id as depends_on_node_id',
      eb('a.id', 'is', null).as('node_absent'),
      eb('b.id', 'is', null).as('target_absent'),
    ])
    .orderBy('d.node_id')
    .orderBy('d.depends_on_node_id')
    .execute();
  return rows.map((row) => {
    const absent = [
      ...(row.node_absent ? [row.node_id] : []),
      ...(row.target_absent ? [row.depends_on_node_id] : []),
    ];
    return finding({
      check: 'dangling-edge',
      evidence: { absent, depends_on_node_id: row.depends_on_node_id, node_id: row.node_id },
      locator: `dependency/${row.node_id}`,
      message: `the dependency ${row.node_id} → ${row.depends_on_node_id} names ${absent.join(' and ')}, which no node row holds`,
      stem: row.node_id,
      where: row.node_absent ? 'dependency · node_id' : 'dependency · depends_on_node_id',
    });
  });
}

/** The four per-project sequence counters, and the column each allocates for. */
const COUNTERS = [
  { column: 'last_seq', highest: 'node_max', kind: 'node' },
  { column: 'last_artifact_seq', highest: 'artifact_max', kind: 'artifact' },
  { column: 'last_seed_seq', highest: 'seed_max', kind: 'seed' },
  { column: 'last_delivery_seq', highest: 'delivery_max', kind: 'delivery' },
] as const;

/**
 * A project counter that sits below the highest sequence of its kind. The next
 * allocation would hand back an identity the store already holds, so the state
 * is reported even though every write path bumps the counter under the same
 * transaction that inserts the row.
 */
async function checkCounterBehind(db: Kysely<DB>): Promise<DoctorFinding[]> {
  const rows = await sql<{
    key: string;
    last_seq: number;
    last_artifact_seq: number;
    last_seed_seq: number;
    last_delivery_seq: number;
    node_max: number;
    artifact_max: number;
    seed_max: number;
    delivery_max: number;
  }>`
    select p.key,
           p.last_seq, p.last_artifact_seq, p.last_seed_seq, p.last_delivery_seq,
           (select coalesce(max(seq), 0) from node     where project_key = p.key) as node_max,
           (select coalesce(max(seq), 0) from artifact where project_key = p.key) as artifact_max,
           (select coalesce(max(seq), 0) from seed     where project_key = p.key) as seed_max,
           (select coalesce(max(seq), 0) from delivery where project_key = p.key) as delivery_max
      from project p
     order by p.key
  `.execute(db);
  const findings: DoctorFinding[] = [];
  for (const row of rows.rows) {
    for (const counter of COUNTERS) {
      const stored = row[counter.column];
      const highest = row[counter.highest];
      if (stored >= highest) {
        continue;
      }
      findings.push(
        finding({
          check: 'counter-behind',
          evidence: { counter: counter.column, highest, kind: counter.kind, stored },
          locator: `project/${row.key}`,
          message: `${row.key} ${counter.column} is ${String(stored)}, below its highest ${counter.kind} sequence ${String(highest)}`,
          scopeKey: row.key,
          severity: 'warn',
          stem: row.key,
          where: `project · ${counter.column}`,
        }),
      );
    }
  }
  return findings;
}

/**
 * A link whose target row is gone: an artifact link to a missing artifact or a
 * missing node, or a scratchpad anchored to a missing node. The artifact links
 * are foreign-keyed, so only the scratchpad anchors — a plain `text[]` a
 * constraint cannot cover — are reachable short of a hand edit.
 */
async function checkOrphanLink(db: Kysely<DB>, dialect: StoreDialect): Promise<DoctorFinding[]> {
  const links = await db
    .selectFrom('artifact_link as l')
    .leftJoin('artifact as a', 'a.id', 'l.artifact_id')
    .leftJoin('node as n', 'n.id', 'l.node_id')
    .where((eb) => eb.or([eb('a.id', 'is', null), eb('n.id', 'is', null)]))
    .select((eb) => [
      'l.artifact_id as artifact_id',
      'l.node_id as node_id',
      eb('a.id', 'is', null).as('artifact_absent'),
    ])
    .orderBy('l.artifact_id')
    .orderBy('l.node_id')
    .execute();
  const findings = links.map((row) => {
    const absent = row.artifact_absent ? row.artifact_id : row.node_id;
    return finding({
      check: 'orphan-link',
      evidence: { artifact_id: row.artifact_id, node_id: row.node_id, value: absent },
      locator: `artifact_link/${row.artifact_id}`,
      message: `the artifact link ${row.artifact_id} → ${row.node_id} names ${absent}, which no row holds`,
      stem: row.artifact_id,
      where: row.artifact_absent ? 'artifact_link · artifact_id' : 'artifact_link · node_id',
    });
  });

  for (const row of await orphanAnchors(db, dialect)) {
    findings.push(
      finding({
        check: 'orphan-link',
        evidence: { anchor: row.anchor, scratchpad: row.id, value: row.anchor },
        locator: `scratchpad/${row.id}`,
        message: `scratchpad ${row.id} is anchored to ${row.anchor}, which no node row holds`,
        scopeKey: row.project_key,
        stem: row.id,
        where: 'scratchpad · anchors',
      }),
    );
  }
  return findings;
}

/**
 * Every scratchpad anchor that names no node, `(id, anchor)` ordered. The
 * anchors are a list column each dialect encodes its own way, so they are
 * decoded here rather than unnested in SQL; a store holds few scratchpads.
 */
async function orphanAnchors(
  db: Kysely<DB>,
  dialect: StoreDialect,
): Promise<{ id: string; project_key: string; anchor: string }[]> {
  const pads = await db
    .selectFrom('scratchpad')
    .select(['id', 'project_key', 'anchors'])
    .orderBy('id')
    .execute();
  const anchored = pads.flatMap((pad) =>
    dialect.codecs.list
      .decode(pad.anchors)
      .toSorted()
      .map((anchor) => ({ anchor, id: pad.id, project_key: pad.project_key })),
  );
  const named = [...new Set(anchored.map((row) => row.anchor))];
  const present = new Set<string>();
  for (const chunk of inLists(named, dialect.maxParameters)) {
    const rows = await db.selectFrom('node').select('id').where('id', 'in', chunk).execute();
    for (const row of rows) {
      present.add(row.id);
    }
  }
  return anchored.filter((row) => !present.has(row.anchor));
}

/**
 * Every stored timestamp column, by table. `stem` is the record a row belongs
 * to — a history or child row is reported against its owner — and `scope` is
 * the owning project where the stem is no identity (a scratchpad's UUID). The
 * names are fixed SQL, never input.
 */
const TIMESTAMP_COLUMNS = [
  {
    columns: ['created_at', 'updated_at', 'archived_at'],
    key: 'key',
    stem: 'key',
    table: 'project',
  },
  { columns: ['created_at', 'updated_at', 'completed_at'], key: 'id', stem: 'id', table: 'node' },
  { columns: ['created_at'], key: 'id', stem: 'node_id', table: 'annotation' },
  { columns: ['created_at', 'updated_at'], key: 'id', stem: 'id', table: 'artifact' },
  {
    columns: ['at'],
    key: 'id',
    stem: 'coalesce(node_id, project_key)',
    table: 'transition_log',
  },
  { columns: ['created_at', 'updated_at'], key: 'id', stem: 'id', table: 'seed' },
  { columns: ['at'], key: 'id', stem: 'seed_id', table: 'seed_history' },
  { columns: ['created_at', 'updated_at'], key: 'id', stem: 'id', table: 'delivery' },
  { columns: ['at'], key: 'id', stem: 'delivery_id', table: 'delivery_history' },
  {
    columns: ['created_at', 'updated_at', 'freezing_at'],
    key: 'id',
    scope: 'project_key',
    stem: 'id',
    table: 'scratchpad',
  },
] as const satisfies readonly {
  columns: readonly string[];
  key: string;
  scope?: string;
  stem: string;
  table: keyof DB;
}[];

/** A stored stamp that is present but not canonical. A plain boolean rather than
 * a type guard, so the caller keeps the value's own type on either branch. */
function isMalformedStamp(value: unknown): boolean {
  return value !== null && !isCanonicalInstant(value);
}

/**
 * A stored timestamp other than the canonical UTC instant, `null` aside in a
 * nullable column. Import copies timestamps as they stand, so a v0.20 export's
 * legacy empty `updated_at` lands verbatim, and reads order on the raw string:
 * an empty value sorts first. The canonical grammar includes calendar validity,
 * which no portable SQL pattern expresses, so every value is read and judged
 * here by {@link isCanonicalInstant}.
 */
async function checkMalformedTimestamp(db: Kysely<DB>): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  for (const spec of TIMESTAMP_COLUMNS) {
    for await (const row of timestampRows(db, spec)) {
      for (const column of spec.columns) {
        const value = row[column];
        if (!isMalformedStamp(value)) {
          continue;
        }
        const locator = `${spec.table}/${String(row.key)}`;
        // JSON quoting keeps a hand-edited control character from breaking the
        // one-line message; the evidence keeps the stored value as it stands.
        const shown = value === '' ? 'empty' : JSON.stringify(String(value));
        findings.push(
          finding({
            check: 'malformed-timestamp',
            evidence: { [column]: value, value },
            locator,
            message: `${locator} ${column} is ${shown}, not a canonical UTC instant`,
            ...(row.scope === null ? {} : { scopeKey: row.scope }),
            severity: 'warn',
            stem: row.stem,
            where: `${spec.table} · ${column}`,
          }),
        );
      }
    }
  }
  return findings;
}

/** Rows per read of one table's timestamps. */
export const TIMESTAMP_BATCH = 1000;

/**
 * One table's key, stem, scope, and timestamp columns, read in key-ordered
 * batches so the scan's memory stays bounded however large the logs grow.
 */
async function* timestampRows(
  db: Kysely<DB>,
  spec: (typeof TIMESTAMP_COLUMNS)[number],
): AsyncGenerator<
  Record<string, string | number | null> & {
    key: string | number;
    stem: string;
    scope: string | null;
  }
> {
  const scope = 'scope' in spec ? `${spec.scope} as scope` : 'null as scope';
  let after: string | number | null = null;
  let full = true;
  while (full) {
    const rows = await sql<
      Record<string, string | number | null> & {
        key: string | number;
        stem: string;
        scope: string | null;
      }
    >`
      select ${sql.raw(`${spec.key} as key, ${spec.stem} as stem, ${scope}, ${spec.columns.join(', ')}`)}
        from ${sql.table(spec.table)}
       ${after === null ? sql`` : sql`where ${sql.ref(spec.key)} > ${after}`}
       order by ${sql.ref(spec.key)}
       limit ${TIMESTAMP_BATCH}
    `.execute(db);
    yield* rows.rows;
    full = rows.rows.length === TIMESTAMP_BATCH;
    after = rows.rows.at(-1)?.key ?? null;
  }
}

/**
 * How many records each project holds — what a scoped run reports it matched.
 * One "record" is one thing the seam can read back: the project row itself,
 * plus its nodes, artifacts, seeds, and scratchpads.
 */
async function countRecords(db: Kysely<DB>): Promise<Map<string, number>> {
  // `count(*)` is a bigint, which node-postgres hands back as a string and
  // PGlite as a number, so the tally is normalized here.
  const rows = await sql<{ key: string; records: string | number }>`
    select p.key,
           1 + (select count(*) from node       where project_key = p.key)
             + (select count(*) from artifact   where project_key = p.key)
             + (select count(*) from seed       where project_key = p.key)
             + (select count(*) from scratchpad where project_key = p.key) as records
      from project p
  `.execute(db);
  return new Map(rows.rows.map((row) => [row.key, Number(row.records)]));
}

/**
 * Every task reference no verb produces. The rule is the import validator's
 * ({@link deliveryReferenceFault}); the rows it judges are read here.
 */
async function checkDeliveryReferences(db: Kysely<DB>): Promise<DoctorFinding[]> {
  const rows = await sql<{
    id: string;
    type: Node['type'];
    lifecycle: Node['lifecycle'];
    parent_id: string | null;
    project_key: string;
    delivery: string;
    delivery_key: string | null;
    delivery_lifecycle: DeliveryLifecycle | null;
    delivery_phase: string | null;
  }>`
    select n.id, n.type, n.lifecycle, n.parent_id, n.project_key, n.delivery,
      d.project_key as delivery_key, d.lifecycle as delivery_lifecycle, d.phase as delivery_phase
    from node n left join delivery d on d.id = n.delivery
    where n.delivery is not null
    order by n.project_key, n.seq
  `.execute(db);
  return rows.rows.flatMap((row) => {
    const delivery =
      row.delivery_key === null || row.delivery_lifecycle === null || row.delivery_phase === null
        ? undefined
        : { key: row.delivery_key, lifecycle: row.delivery_lifecycle, phase: row.delivery_phase };
    const fault = deliveryReferenceFault({ ...row, project_id: row.project_key }, delivery);
    return fault === null
      ? []
      : [
          finding({
            check: 'invalid-delivery',
            evidence: { delivery: row.delivery },
            locator: `node/${row.id}`,
            message: `delivery ${row.delivery} ${fault}`,
            stem: row.id,
            where: 'node · delivery',
          }),
        ];
  });
}

/** An orphaned owned link must remain visible even when its decision row is absent. */
async function checkOrphanDecisionLinks(db: Kysely<DB>): Promise<DoctorFinding[]> {
  const rows = await db
    .selectFrom('decision_task')
    .leftJoin('decision', 'decision.id', 'decision_task.decision_id')
    .select(['decision_task.decision_id', 'decision_task.task'])
    .where('decision.id', 'is', null)
    .execute();
  return rows.map((row) =>
    finding({
      check: 'invalid-decision',
      evidence: { task: row.task },
      locator: `decision_task/${row.decision_id}/${row.task}`,
      message: 'link names a missing decision',
      stem: row.decision_id,
      where: 'decision_task',
    }),
  );
}

/**
 * Validate decisions over one snapshot, so a write committing mid-check never
 * pairs a decision row with history from after it.
 */
function checkDecisions(db: Kysely<DB>, dialect: StoreDialect): Promise<DoctorFinding[]> {
  return dialect.snapshot(db, (tx) => checkDecisionsIn(tx, dialect));
}

/** Read only decisions and the identity fields needed to validate their references. */
async function checkDecisionsIn(db: Kysely<DB>, dialect: StoreDialect): Promise<DoctorFinding[]> {
  const decisions = await exportDecisions(db, dialect);
  const projects: { key: string; counters: { decision: number } }[] = [];
  const nodes: { id: string; type: Node['type']; project_id: string }[] = [];
  const deliveries: { id: string; project_key: string }[] = [];
  const keys = [...new Set(decisions.map((d) => d.project_key))];
  const tasks = [
    ...new Set(
      decisions.flatMap((d) => [
        ...d.tasks,
        ...d.history.flatMap((h) => (h.task === null ? [] : [h.task])),
      ]),
    ),
  ];
  const refs = [
    ...new Set(
      decisions.flatMap((d) =>
        [
          d.delivery,
          ...d.history.flatMap((h) => (h.kind === 'delivery' ? [h.from_value, h.to_value] : [])),
        ].filter((id) => id !== null),
      ),
    ),
  ];
  for (const chunk of inLists(keys, dialect.maxParameters)) {
    const rows = await db
      .selectFrom('project')
      .select(['key', 'last_decision_seq'])
      .where('key', 'in', chunk)
      .execute();
    projects.push(
      ...rows.map((p) => ({ counters: { decision: p.last_decision_seq }, key: p.key })),
    );
  }
  for (const chunk of inLists(tasks, dialect.maxParameters)) {
    const rows = await db
      .selectFrom('node')
      .select(['id', 'type', 'project_key'])
      .where('id', 'in', chunk)
      .execute();
    nodes.push(...rows.map((n) => ({ id: n.id, project_id: n.project_key, type: n.type })));
  }
  for (const chunk of inLists(refs, dialect.maxParameters)) {
    deliveries.push(
      ...(await db
        .selectFrom('delivery')
        .select(['id', 'project_key'])
        .where('id', 'in', chunk)
        .execute()),
    );
  }
  const findings = decisionFaults({ decisions, deliveries, nodes, projects }).map(
    ({ id, message }) =>
      finding({
        check: 'invalid-decision',
        evidence: {},
        locator: `decision/${id}`,
        message,
        stem: id,
        where: 'decision',
      }),
  );
  const orphans = await db
    .selectFrom('decision_history')
    .leftJoin('decision', 'decision.id', 'decision_history.decision_id')
    .select(['decision_history.id', 'decision_history.decision_id'])
    .where('decision.id', 'is', null)
    .execute();
  findings.push(
    ...orphans.map((h) =>
      finding({
        check: 'invalid-decision',
        evidence: {},
        locator: `decision_history/${String(h.id)}`,
        message: 'history names a missing decision',
        stem: h.decision_id,
        where: 'decision_history',
      }),
    ),
  );
  return findings;
}

/**
 * The checklist rules the verbs keep (ADR 0044), over every stored item with
 * the type of the node it names. A missing node reads as absent, so the
 * fault says so rather than the join dropping the row.
 */
async function checkChecklistItems(db: Kysely<DB>): Promise<DoctorFinding[]> {
  const rows = await db
    .selectFrom('checklist_item')
    .leftJoin('node', 'node.id', 'checklist_item.node_id')
    .select([
      'checklist_item.node_id as task',
      'checklist_item.number',
      'checklist_item.content',
      'checklist_item.state',
      'checklist_item.reason',
      'checklist_item.created_at',
      'checklist_item.settled_at',
      'node.type as node_type',
    ])
    .orderBy('checklist_item.node_id')
    .orderBy('checklist_item.number')
    .execute();
  const nodes = new Map(
    rows.flatMap((row) => (row.node_type === null ? [] : [[row.task, { type: row.node_type }]])),
  );
  return checklistFaults(
    rows.map(({ node_type: _type, ...row }) => row),
    nodes,
  ).map(({ id, message }) => {
    const task = id.slice(0, id.indexOf(' '));
    return finding({
      check: 'invalid-checklist-item',
      evidence: {},
      locator: `checklist_item/${id.replace(' item ', '/')}`,
      message: `${id} ${message}`,
      stem: task,
      where: 'checklist_item',
    });
  });
}

/** Findings for `scope`, or all of them when the run is unscoped. */
async function diagnose(
  db: Kysely<DB>,
  dialect: StoreDialect,
  scope: string | undefined,
): Promise<DoctorFinding[]> {
  // The schema check runs alone, first: the table queries below assume the
  // current schema's shape and can throw against an absent or older one, so a
  // mismatch here is the whole diagnosis rather than one finding among many.
  const schemaFindings = await checkSchemaVersion(db, dialect);
  if (schemaFindings.length > 0) {
    return schemaFindings;
  }
  const findings = (
    await Promise.all([
      checkDeliveryReferences(db),
      checkOrphanDecisionLinks(db),
      checkDecisions(db, dialect),
      checkChecklistItems(db),
      checkDanglingParent(db),
      checkDanglingEdge(db),
      checkCounterBehind(db),
      checkOrphanLink(db, dialect),
      checkMalformedTimestamp(db),
    ])
  ).flat();
  if (isUnscoped(scope)) {
    return findings;
  }
  // A store-level finding belongs to no project, so a project scope excludes it
  // rather than attributing it to the scoped key.
  return findings.filter((item) => item.scopeKey === scope);
}

/** The plain-language cause chip the record-health panel shows per check. A
 * SQL finding's code is its check, so the table keys either. The `satisfies`
 * keeps it exhaustive over the check vocabulary. */
const CAUSES: Readonly<Record<string, string>> = {
  'counter-behind': 'counter behind',
  'dangling-edge': 'dangling dependency',
  'dangling-parent': 'dangling parent',
  'invalid-checklist-item': 'invalid checklist item',
  'invalid-decision': 'invalid decision',
  'invalid-delivery': 'invalid delivery reference',
  'malformed-timestamp': 'malformed timestamp',
  'orphan-link': 'orphan link',
  'schema-version': 'schema version mismatch',
} satisfies Record<SqlCheck, string>;

/** Build the doctor facet over one open handle and the dialect it speaks. */
export function createSqlDoctorBackend(db: Kysely<DB>, dialect: StoreDialect): DoctorBackend {
  const scopeMatch = async (scope: string | undefined): Promise<DoctorScopeMatch> =>
    isUnscoped(scope)
      ? null
      : { key: scope, matched_records: (await countRecords(db)).get(scope) ?? 0 };

  return {
    diagnose: async (scope): Promise<DoctorDiagnosis> => ({
      findings: await diagnose(db, dialect, scope),
      scope: await scopeMatch(scope),
    }),
    facet: async (scope): Promise<DoctorFacet> =>
      withFindings(
        { finding_total: 0, groups: [], scanned_at: now(), scope: await scopeMatch(scope) },
        await diagnose(db, dialect, scope),
        CAUSES,
      ),
  };
}
