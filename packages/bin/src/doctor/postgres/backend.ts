/**
 * The Postgres backend's implementation of the neutral doctor contract (ADR
 * 0030 Decision 6). Where the Norn doctor reads documents, this one reads rows:
 * every check is one query whose result set IS the finding list.
 *
 * There is no `repair`. On this backend the constraints are the validator: a
 * foreign key, a primary key, and a `CHECK` over each closed vocabulary make
 * nearly every state the Norn checks look for unrepresentable. What remains is
 * the short list below — reachable only through a hand edit at the `psql`
 * prompt, or through the one deferred foreign key inside a failed import — and
 * a state a human produced by hand is a state a human resolves by hand.
 *
 * Connectivity is not a finding. A query that cannot reach the database throws,
 * and doctor's own nonzero exit reports it: an unreachable store has no record
 * health to report, clean or otherwise.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { parseIdentity } from '../../core/ids';
import type { DB } from '../../core/store-postgres/index';
import { readSchemaVersion, SCHEMA_VERSION } from '../../core/store-postgres/index';
import { now } from '../../core/time';
import type { DoctorBackend, DoctorDiagnosis, DoctorFinding, DoctorScopeMatch } from '../contract';
import type { DoctorFacet, DoctorGroup, DoctorRecord } from '../facet';

/**
 * The scope key store-level findings carry. A schema version belongs to the
 * database, not to a project, so it owns a scope word no project key can be
 * (keys are two to four uppercase letters).
 */
const STORE_SCOPE = 'store';

/** The closed code vocabulary this backend reports. */
type PostgresCheck =
  | 'counter-behind'
  | 'dangling-edge'
  | 'dangling-parent'
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
  check: PostgresCheck;
  evidence: Readonly<Record<string, unknown>>;
  locator: string;
  message: string;
  scopeKey?: string;
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
    severity: 'error',
    stem: input.stem,
    where: input.where,
  };
}

/**
 * The stored schema version against the one this binary reads.
 *
 * Unreachable through the composition root — `assertSchemaCurrent` refuses the
 * connection before a store exists — but reported all the same, because a
 * caller that holds a handle directly (the upgrade command's, a test's) is
 * owed the answer rather than an empty diagnosis.
 */
async function checkSchemaVersion(db: Kysely<DB>): Promise<DoctorFinding[]> {
  const version = await readSchemaVersion(db);
  if (version === SCHEMA_VERSION) {
    return [];
  }
  const stored = version === null ? 'absent' : String(version);
  return [
    finding({
      check: 'schema-version',
      evidence: { binary: SCHEMA_VERSION, stored: version },
      locator: 'schema_version',
      message: `the store schema is ${stored === 'absent' ? 'absent' : `version ${stored}`}; this binary reads version ${String(SCHEMA_VERSION)} — run 'mimir store upgrade'`,
      scopeKey: STORE_SCOPE,
      stem: STORE_SCOPE,
      where: 'schema_version · version',
    }),
  ];
}

/**
 * A node whose `parent_id` names no node row. The parent foreign key is the one
 * deferred constraint in the schema (a self-reference an import satisfies only
 * once the whole tree has landed), so this is the single dangling reference the
 * database itself could leave behind — after an import that failed between the
 * insert and the commit.
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
      where: 'dependency · node_id',
    });
  });
}

/** The three per-project sequence counters, and the column each allocates for. */
const COUNTERS = [
  { column: 'last_seq', highest: 'node_max', kind: 'node' },
  { column: 'last_artifact_seq', highest: 'artifact_max', kind: 'artifact' },
  { column: 'last_seed_seq', highest: 'seed_max', kind: 'seed' },
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
    node_max: number;
    artifact_max: number;
    seed_max: number;
  }>`
    select p.key,
           p.last_seq, p.last_artifact_seq, p.last_seed_seq,
           (select coalesce(max(seq), 0) from node     where project_key = p.key) as node_max,
           (select coalesce(max(seq), 0) from artifact where project_key = p.key) as artifact_max,
           (select coalesce(max(seq), 0) from seed     where project_key = p.key) as seed_max
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
async function checkOrphanLink(db: Kysely<DB>): Promise<DoctorFinding[]> {
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

  const anchors = await sql<{ id: string; project_key: string; anchor: string }>`
    select s.id, s.project_key, a.anchor
      from scratchpad s
      cross join lateral unnest(s.anchors) as a(anchor)
      left join node n on n.id = a.anchor
     where n.id is null
     order by s.id, a.anchor
  `.execute(db);
  for (const row of anchors.rows) {
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
 * How many records each project holds — the denominator both the scope match
 * and the facet's readable tally are computed from. One "record" is one thing
 * the seam can read back: the project row itself, plus its nodes, artifacts,
 * seeds, and scratchpads.
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

/** Findings for `scope`, or all of them when the run is unscoped. */
async function diagnose(db: Kysely<DB>, scope: string | undefined): Promise<DoctorFinding[]> {
  const findings = (
    await Promise.all([
      checkSchemaVersion(db),
      checkDanglingParent(db),
      checkDanglingEdge(db),
      checkCounterBehind(db),
      checkOrphanLink(db),
    ])
  ).flat();
  if (scope === undefined || scope === '') {
    return findings;
  }
  // A store-level finding belongs to no project, so a project scope excludes it
  // rather than attributing it to the scoped key.
  return findings.filter((item) => item.scopeKey === scope);
}

/** The plain-language cause chip the record-health panel shows per check. The
 * `satisfies` keeps the table exhaustive over the check vocabulary while the
 * index signature lets a finding's `string` check look itself up. */
const CAUSES: Readonly<Record<string, string>> = {
  'counter-behind': 'counter behind',
  'dangling-edge': 'dangling dependency',
  'dangling-parent': 'dangling parent',
  'orphan-link': 'orphan link',
  'schema-version': 'schema version mismatch',
} satisfies Record<PostgresCheck, string>;

/** The column a finding's `where` names, e.g. `node · parent_id` → `parent_id`. */
function fieldOf(where: string): string | null {
  const tail = where.split(' · ')[1];
  return tail === undefined || tail === '' ? null : tail;
}

/**
 * One finding as a panel record. Every locate-derived field is null: there is
 * no file to open, no line to point at, and no closed vocabulary to suggest a
 * nearest member of — the row IS the evidence, and `path` carries the table and
 * key that reaches it.
 */
function toRecord(item: DoctorFinding): DoctorRecord {
  const value = item.evidence.value;
  return {
    cause: CAUSES[item.check] ?? item.check,
    field: fieldOf(item.where),
    id: item.stem,
    location: null,
    note: item.message,
    path: item.locator,
    severity: item.severity,
    snippet: null,
    suggestion: null,
    title: null,
    value: typeof value === 'string' ? value : null,
  };
}

/** Group the findings by owning project — the facet's file-group analogue. */
function toGroups(
  findings: readonly DoctorFinding[],
  records: ReadonlyMap<string, number>,
): DoctorGroup[] {
  const groups = new Map<string, { records: DoctorRecord[]; stems: Set<string> }>();
  for (const item of findings) {
    let group = groups.get(item.scopeKey);
    if (group === undefined) {
      group = { records: [], stems: new Set() };
      groups.set(item.scopeKey, group);
    }
    group.records.push(toRecord(item));
    group.stems.add(item.stem);
  }
  return [...groups]
    .map(([project, group]) => ({
      dropped: group.records.length,
      // A group's "directory" on a store that has none: the project key. The
      // per-record table and key live on each record's own `path`.
      path: project,
      project,
      readable: Math.max(0, (records.get(project) ?? 0) - group.stems.size),
      records: group.records,
    }))
    .toSorted((a, b) => a.project.localeCompare(b.project));
}

/** Build the Postgres doctor facet over one open handle. */
export function createPostgresDoctorBackend(db: Kysely<DB>): DoctorBackend {
  const scopeMatch = async (scope: string | undefined): Promise<DoctorScopeMatch> =>
    scope === undefined || scope === ''
      ? null
      : { key: scope, matched_documents: (await countRecords(db)).get(scope) ?? 0 };

  return {
    diagnose: async (scope): Promise<DoctorDiagnosis> => ({
      findings: await diagnose(db, scope),
      scope: await scopeMatch(scope),
    }),
    facet: async (scope): Promise<DoctorFacet> => {
      const findings = await diagnose(db, scope);
      const records = await countRecords(db);
      return {
        dropped_total: findings.length,
        groups: toGroups(findings, records),
        scanned_at: now(),
        scope: await scopeMatch(scope),
      };
    },
  };
}
