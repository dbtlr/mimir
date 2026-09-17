import { expect, test } from 'bun:test';

import { PGlite } from '@electric-sql/pglite';
import { Kysely, sql } from 'kysely';

import { createProject } from '../../core/create';
import type { Store } from '../../core/store';
import type { DB } from '../../core/store-postgres/index';
import { createPgliteDialect } from '../../core/store-postgres/pglite';
import { createPgliteTestStore } from '../../core/store-postgres/testing';
import { seedWorkingSet } from '../../testing/conformance';
import type { DoctorBackend, DoctorFinding } from '../contract';
import { createPostgresDoctorBackend } from './backend';

/**
 * The Postgres doctor facet. Every state under test is one a constraint would
 * normally forbid, so each case stages it with the foreign-key triggers turned
 * off (`session_replication_role = replica`) — the closest a test can get to
 * the hand edit at the `psql` prompt these checks exist to catch.
 */

type Fixture = {
  db: Kysely<DB>;
  store: Store;
  doctor: DoctorBackend;
  close: () => Promise<void>;
};

async function fixture(): Promise<Fixture> {
  const test_ = await createPgliteTestStore();
  return {
    close: test_.close,
    db: test_.db,
    doctor: createPostgresDoctorBackend(test_.db),
    store: test_.store,
  };
}

/** Run raw DDL/DML with the foreign-key triggers suspended for the session. */
async function unconstrained(db: Kysely<DB>, statements: readonly string[]): Promise<void> {
  await sql.raw('SET session_replication_role = replica').execute(db);
  try {
    for (const statement of statements) {
      await sql.raw(statement).execute(db);
    }
  } finally {
    await sql.raw('SET session_replication_role = origin').execute(db);
  }
}

function byCode(findings: readonly DoctorFinding[], code: string): DoctorFinding[] {
  return findings.filter((item) => item.code === code);
}

test('a healthy store diagnoses clean', async () => {
  const f = await fixture();
  try {
    await seedWorkingSet(f.store);
    expect((await f.doctor.diagnose(undefined)).findings).toEqual([]);
    expect(await f.doctor.facet(undefined)).toMatchObject({ dropped_total: 0, groups: [] });
  } finally {
    await f.close();
  }
});

test('the Postgres doctor carries no repair capability', async () => {
  const f = await fixture();
  try {
    expect(f.doctor.repair).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('a node whose parent_id names no row reports dangling-parent', async () => {
  const f = await fixture();
  try {
    await seedWorkingSet(f.store);
    await unconstrained(f.db, ["UPDATE node SET parent_id = 'MMR-404' WHERE id = 'MMR-2'"]);

    const [item, ...rest] = byCode(
      (await f.doctor.diagnose(undefined)).findings,
      'dangling-parent',
    );
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      check: 'dangling-parent',
      locator: 'node/MMR-2',
      scopeKey: 'MMR',
      severity: 'error',
      stem: 'MMR-2',
      where: 'node · parent_id',
    });
    expect(item?.message).toContain('MMR-404');
    expect(item?.evidence).toMatchObject({ parent_id: 'MMR-404' });
  } finally {
    await f.close();
  }
});

test('a dependency edge with a missing target reports dangling-edge against depends_on_node_id', async () => {
  const f = await fixture();
  try {
    await seedWorkingSet(f.store);
    await unconstrained(f.db, [
      "INSERT INTO dependency (node_id, depends_on_node_id) VALUES ('MMR-3', 'MMR-404')",
    ]);

    const [item, ...rest] = byCode((await f.doctor.diagnose(undefined)).findings, 'dangling-edge');
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      locator: 'dependency/MMR-3',
      scopeKey: 'MMR',
      stem: 'MMR-3',
      // The absent end is the target, so `where` must name it rather than the
      // present source end.
      where: 'dependency · depends_on_node_id',
    });
    // Only the absent end is named — the present one is not the problem.
    expect(item?.evidence).toMatchObject({ absent: ['MMR-404'] });
  } finally {
    await f.close();
  }
});

test('a dependency edge with a missing source reports dangling-edge against node_id', async () => {
  const f = await fixture();
  try {
    await seedWorkingSet(f.store);
    await unconstrained(f.db, [
      "INSERT INTO dependency (node_id, depends_on_node_id) VALUES ('MMR-404', 'MMR-3')",
    ]);

    const [item, ...rest] = byCode((await f.doctor.diagnose(undefined)).findings, 'dangling-edge');
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      locator: 'dependency/MMR-404',
      stem: 'MMR-404',
      where: 'dependency · node_id',
    });
    expect(item?.evidence).toMatchObject({ absent: ['MMR-404'] });
  } finally {
    await f.close();
  }
});

test('a project counter below its highest sequence reports counter-behind, per kind', async () => {
  const f = await fixture();
  try {
    await seedWorkingSet(f.store);
    await sql
      .raw("UPDATE project SET last_seq = 0, last_artifact_seq = 0 WHERE key = 'MMR'")
      .execute(f.db);

    const findings = byCode((await f.doctor.diagnose(undefined)).findings, 'counter-behind');
    expect(findings.map((item) => item.evidence.kind)).toEqual(['node', 'artifact']);
    expect(findings[0]).toMatchObject({
      locator: 'project/MMR',
      scopeKey: 'MMR',
      // A counter behind its rows hides nothing on read, so it is a warning,
      // not an error (the neutral contract in doctor/contract.ts).
      severity: 'warn',
      stem: 'MMR',
      where: 'project · last_seq',
    });
    expect(findings[0]?.evidence).toMatchObject({ stored: 0 });
    expect(Number(findings[0]?.evidence.highest)).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

test('an artifact link and a scratchpad anchor to a missing node both report orphan-link', async () => {
  const f = await fixture();
  try {
    await seedWorkingSet(f.store);
    await unconstrained(f.db, [
      "INSERT INTO artifact_link (artifact_id, node_id) VALUES ('MMR-a1', 'MMR-404')",
      "UPDATE scratchpad SET anchors = anchors || ARRAY['MMR-404']",
    ]);

    const findings = byCode((await f.doctor.diagnose(undefined)).findings, 'orphan-link');
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      locator: 'artifact_link/MMR-a1',
      scopeKey: 'MMR',
      where: 'artifact_link · node_id',
    });
    // A scratchpad's stem is a UUID, so its owning project comes from the row,
    // never from the identity.
    expect(findings[1]).toMatchObject({
      scopeKey: 'MMR',
      where: 'scratchpad · anchors',
    });
    expect(findings[1]?.locator).toStartWith('scratchpad/');
  } finally {
    await f.close();
  }
});

test('a stored schema version other than this binary reports schema-version', async () => {
  const f = await fixture();
  try {
    await sql
      .raw("INSERT INTO schema_version (version, applied_at) VALUES (99, 'x')")
      .execute(f.db);

    const [item, ...rest] = byCode((await f.doctor.diagnose(undefined)).findings, 'schema-version');
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      locator: 'schema_version',
      scopeKey: 'store',
      stem: 'store',
      where: 'schema_version · version',
    });
    expect(item?.message).toContain('version 99');
  } finally {
    await f.close();
  }
});

test('a database with no schema at all reports only schema-version, without throwing', async () => {
  // No `upgradeSchema` call: the table queries the other checks run would
  // throw against a database that has none of their tables yet.
  const db = new Kysely<DB>({ dialect: createPgliteDialect(new PGlite()) });
  const doctor = createPostgresDoctorBackend(db);
  try {
    const { findings } = await doctor.diagnose(undefined);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'schema-version', scopeKey: 'store' });
  } finally {
    await db.destroy();
  }
});

test('connectivity failure throws rather than becoming a finding', async () => {
  const f = await fixture();
  await f.close();
  // Doctor's own nonzero exit reports an unreachable store: there is no record
  // health to report, clean or otherwise. try/catch rather than `.rejects`,
  // which the await-thenable lint refuses here.
  let threw = false;
  try {
    await f.doctor.diagnose(undefined);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test('a project scope narrows to that project and excludes another project', async () => {
  const f = await fixture();
  try {
    await seedWorkingSet(f.store);
    await createProject(f.store, { description: null, key: 'ZZZ', name: 'Zed' });
    await sql.raw("UPDATE project SET last_seq = 0 WHERE key = 'MMR'").execute(f.db);
    await unconstrained(f.db, ["UPDATE node SET parent_id = 'MMR-404' WHERE id = 'MMR-2'"]);
    // ZZZ has a finding of its own, so scoping to MMR must exclude it.
    await unconstrained(f.db, [
      "INSERT INTO node (id, project_key, type, seq, title, next_present, created_at, updated_at) VALUES ('ZZZ-1', 'ZZZ', 'task', 1, 'Zed task', false, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')",
      "UPDATE node SET parent_id = 'ZZZ-404' WHERE id = 'ZZZ-1'",
    ]);

    const scoped = await f.doctor.diagnose('MMR');
    expect(scoped.findings.map((item) => item.scopeKey)).toEqual(['MMR', 'MMR']);
    expect(scoped.scope?.key).toBe('MMR');
    expect(scoped.scope?.matched_documents).toBeGreaterThan(0);

    const all = await f.doctor.diagnose(undefined);
    expect(all.scope).toBeNull();
    expect(new Set(all.findings.map((item) => item.scopeKey))).toEqual(new Set(['MMR', 'ZZZ']));
  } finally {
    await f.close();
  }
});

test('a schema mismatch dominates scoping: even a project scope sees only the schema-version finding', async () => {
  const f = await fixture();
  try {
    await seedWorkingSet(f.store);
    await sql.raw("UPDATE project SET last_seq = 0 WHERE key = 'MMR'").execute(f.db);
    await sql
      .raw("INSERT INTO schema_version (version, applied_at) VALUES (99, 'x')")
      .execute(f.db);

    const scoped = await f.doctor.diagnose('MMR');
    expect(scoped.findings.map((item) => item.check)).toEqual(['schema-version']);
  } finally {
    await f.close();
  }
});

test('the facet groups records by project and carries the table and key as the path', async () => {
  const f = await fixture();
  try {
    await seedWorkingSet(f.store);
    await createProject(f.store, { description: null, key: 'ZZZ', name: 'Zed' });
    await unconstrained(f.db, ["UPDATE node SET parent_id = 'MMR-404' WHERE id = 'MMR-2'"]);

    const facet = await f.doctor.facet(undefined);
    expect(facet.dropped_total).toBe(1);
    expect(facet.groups).toHaveLength(1);
    const group = facet.groups[0];
    expect(group).toMatchObject({ dropped: 1, project: 'MMR' });
    // Readable is the project's remaining records — the whole project minus the
    // one record the finding names.
    expect(group?.readable).toBeGreaterThan(0);
    expect(group?.records[0]).toMatchObject({
      cause: 'dangling parent',
      field: 'parent_id',
      id: 'MMR-2',
      // There is no file behind a row: the table and the key reach it instead.
      path: 'node/MMR-2',
      severity: 'error',
      value: 'MMR-404',
    });
    expect(group?.records[0]?.location).toBeNull();
    expect(group?.records[0]?.snippet).toBeNull();
    expect(facet.scanned_at).not.toBe('');
  } finally {
    await f.close();
  }
});
