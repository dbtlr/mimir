import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { createProject } from './create';
import { createHostSecretStore } from './host-secrets';
import { createRunStore } from './runs';
import type { AdmitRun } from './runs';
import { sqliteDialect } from './store-sqlite/dialect';
import { createSqliteTestStore } from './store-sqlite/testing';
import type { SqliteTestStore } from './store-sqlite/testing';
import { pairTestDevice } from './testing/store';
import { createTokenStore } from './tokens';

/**
 * Host state never travels. Device tokens, pairing requests, host secrets, and
 * runs belong to the host that holds them: an export carries none of them, and
 * an import leaves the target's own untouched even when the document carries
 * rows for them. Runs on SQLite alone: the export and import are shared SQL.
 */

const open: SqliteTestStore[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) {
    await handle.close();
  }
});

const clock = () => '2026-11-01T12:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const admission = (id: string, runner: string): AdmitRun => ({
  budget: { dailyTokens: Number.MAX_SAFE_INTEGER, since: '2026-11-01T00:00:00.000Z' },
  id,
  kind: 'groom',
  model: 'opus',
  project: 'MMR',
  reservedTokens: 1000,
  runner,
  staleAfterMs: 60_000,
  task: 'MMR-1',
  trigger: 'console',
});

/** A store (with a project only when asked, so a fresh import can land) seeded with one device, one pending pairing, one secret, and one run, all named by `label`. */
async function host(label: string, seedProject: boolean) {
  const handle = await createSqliteTestStore();
  open.push(handle);
  const { db, store } = handle;
  const tokens = createTokenStore({ clock, db, dialect: sqliteDialect });
  const secrets = createHostSecretStore({ clock, db, dialect: sqliteDialect });
  const runs = createRunStore({ clock, db, dialect: sqliteDialect });
  if (seedProject) {
    await createProject(store, { key: 'MMR', name: 'Mimir' });
  }
  const token = await pairTestDevice(tokens, `${label}-device`);
  const pending = await tokens.request(`${label}-pending`);
  await secrets.write(`${label}.oauth`, `v1.${label}-sealed`);
  await runs.admit(admission(`${label}-run`, `${label}-runner`));
  return { db, pending, runs, secrets, store, token, tokens };
}

test('tokens, host secrets, and runs stay out of the transfer document, and an import leaves the target own intact', async () => {
  const source = await host('source', true);
  const document = await source.store.export();

  const exported = JSON.stringify(document);
  // Tokens: the secret, its stored hash, the device name, the pairing request.
  expect(exported).not.toContain(source.token);
  expect(exported).not.toContain(hash(source.token));
  expect(exported).not.toContain('source-device');
  expect(exported).not.toContain('source-pending');
  expect(exported).not.toContain(hash(source.pending.poll_secret));
  // Host secrets: the name and the sealed text.
  expect(exported).not.toContain('source.oauth');
  expect(exported).not.toContain('v1.source-sealed');
  // Runs: the id and the runner.
  expect(exported).not.toContain('source-run');
  expect(exported).not.toContain('source-runner');

  const target = await host('target', false);
  const before = await target.tokens.list({ all: true });
  // A document that does carry the source's host rows, as an older or hand-built one could.
  const enriched = {
    ...document,
    device_tokens: await source.db.selectFrom('device_tokens').selectAll().execute(),
    host_secrets: await source.db.selectFrom('host_secrets').selectAll().execute(),
    pairing_requests: await source.db.selectFrom('pairing_requests').selectAll().execute(),
    runs: await source.db.selectFrom('runs').selectAll().execute(),
  };
  await target.store.import(enriched, { dryRun: true, mode: 'fresh' });
  await target.store.import(enriched, { dryRun: false, mode: 'fresh' });
  await target.store.import(enriched, { dryRun: false, mode: 'resume' });

  expect(await target.tokens.list({ all: true })).toEqual(before);
  expect(await target.tokens.verify(source.token)).toBeNull();
  expect(await target.tokens.verify(target.token)).toBe('target-device');
  expect(await target.tokens.approve(target.pending.user_code)).toMatchObject({
    device: 'target-pending',
  });
  expect(await target.secrets.read('target.oauth')).toBe('v1.target-sealed');
  expect(await target.secrets.read('source.oauth')).toBeUndefined();
  expect((await target.runs.running())?.id).toBe('target-run');
  expect(await target.runs.get('source-run')).toBeUndefined();
});
