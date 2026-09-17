import { expect, test } from 'bun:test';

import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { createProject } from '../../core/create';
import type { Store } from '../../core/store';
import type { DB } from '../../core/store-postgres/index';
import { createPgliteTestStore } from '../../core/store-postgres/index';
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

test('a dependency edge with a missing end reports dangling-edge', async () => {
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
      where: 'dependency · node_id',
    });
    // Only the absent end is named — the present one is not the problem.
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

test('a project scope narrows to that project and excludes store-level findings', async () => {
  const f = await fixture();
  try {
    await seedWorkingSet(f.store);
    await sql.raw("UPDATE project SET last_seq = 0 WHERE key IN ('MMR', 'OPS')").execute(f.db);
    await sql
      .raw("INSERT INTO schema_version (version, applied_at) VALUES (99, 'x')")
      .execute(f.db);

    const scoped = await f.doctor.diagnose('MMR');
    expect(scoped.findings.map((item) => item.scopeKey)).toEqual(['MMR']);
    expect(scoped.scope?.key).toBe('MMR');
    expect(scoped.scope?.matched_documents).toBeGreaterThan(0);

    const all = await f.doctor.diagnose(undefined);
    expect(all.scope).toBeNull();
    expect(new Set(all.findings.map((item) => item.scopeKey))).toEqual(new Set(['MMR', 'store']));
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
