import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';

import { readSinceSources } from '../store-sql/delivery-since';
import { readySqlite } from './client';
import { sqliteDialect } from './dialect';

/**
 * The since read must not scan whole tables (ADR 0042, MMR-692). Run the real
 * read, capture each statement it prepares, and ask SQLite how it would run the
 * three that name a delivery in a table with no key of its own: every one must
 * search an index.
 */
test('the since read’s artifact, decision, and decision-history lookups use an index', async () => {
  const database = new Database(':memory:', { create: true, readwrite: true, strict: true });
  const handle = await readySqlite(database, ':memory:');
  try {
    const prepared: string[] = [];
    const prepare = database.prepare.bind(database) as (sql: string) => unknown;
    spyOn(database, 'prepare').mockImplementation(((sql: string) => {
      prepared.push(sql);
      return prepare(sql);
    }) as never);
    await readSinceSources(handle.db, sqliteDialect, 'MMR-d1');

    const lookups = [
      { table: 'artifact', text: 'from "artifact"' },
      { table: 'decision', text: 'from "decision" where' },
      { table: 'decision_history', text: '"kind" = ?' },
    ].map(({ table, text }) => {
      const sql = prepared.find((candidate) => candidate.toLowerCase().includes(text));
      expect(sql, `the read prepared no statement for ${table}`).toBeDefined();
      return { sql: sql as string, table };
    });
    for (const { sql, table } of lookups) {
      const marks = sql.split('?').length - 1;
      const plan = database
        .query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: marks }, () => 'x'))
        .map((row) => row.detail);
      expect(plan.length, `${table}: ${sql}`).toBeGreaterThan(0);
      for (const detail of plan) {
        expect(detail, `${table}: ${sql}`).not.toMatch(/^SCAN /);
      }
      expect(plan.join('\n'), `${table}: ${sql}`).toMatch(/USING (COVERING )?INDEX/);
    }
  } finally {
    await handle.close();
  }
});
