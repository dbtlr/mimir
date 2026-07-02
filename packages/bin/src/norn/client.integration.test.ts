import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from '../exec';
import { converge } from '../vault/converge';
import { NornClient } from './client';

/**
 * The live integration slice: a real `norn mcp` subprocess over a vault the
 * converge engine scaffolded. Skipped when the norn binary isn't on PATH
 * (CI) — the in-memory suite covers the client machinery; this covers the
 * actual wire contract against the actual engine.
 */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-norn-'));
  await converge(join(root, 'vault'), { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: join(root, 'vault') });
});
afterEach(async () => {
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

test.skipIf(!NORN)('create → find → get round-trips an artifact through real norn', async () => {
  // dry-run first: nothing written
  const dryRun = await client.newDoc({
    body: '# Spec\n\nbody\n',
    field_json: [
      'type="artifact"',
      'title="Round-trip spec"',
      'project="[[MMR]]"',
      'created="2026-07-02T12:00:00"',
    ],
    parents: true,
    path: 'MMR/artifacts/MMR-a1.md',
  });
  expect(dryRun).toBeDefined();
  expect(await client.find({ eq: ['type:artifact'] })).toEqual([]);

  // confirmed: the file lands and is queryable
  await client.newDoc({
    body: '# Spec\n\nbody\n',
    confirm: true,
    field_json: [
      'type="artifact"',
      'title="Round-trip spec"',
      'project="[[MMR]]"',
      'created="2026-07-02T12:00:00"',
    ],
    parents: true,
    path: 'MMR/artifacts/MMR-a1.md',
  });

  const docs = await client.find({ col: ['title'], eq: ['type:artifact'] });
  expect(docs).toHaveLength(1);
  expect(docs[0]?.path).toBe('MMR/artifacts/MMR-a1.md');
  expect(docs[0]?.frontmatter?.title).toBe('Round-trip spec');

  // the dangling-anchor query MMR-143 rests on: match by stored wikilink text
  const byProject = await client.find({ eq: ['project:MMR', 'type:artifact'] });
  expect(byProject).toHaveLength(1);

  const records = await client.get(['MMR/artifacts/MMR-a1.md']);
  expect(records).toHaveLength(1);
});

test.skipIf(!NORN)('set updates frontmatter through the mutation contract', async () => {
  await client.newDoc({
    confirm: true,
    field_json: [
      'type="artifact"',
      'title="Before"',
      'project="[[MMR]]"',
      'created="2026-07-02T12:00:00"',
    ],
    parents: true,
    path: 'MMR/artifacts/MMR-a2.md',
  });
  await client.set({
    confirm: true,
    set: { title: 'After' },
    target: 'MMR/artifacts/MMR-a2.md',
  });
  const docs = await client.find({ col: ['title'], eq: ['type:artifact'] });
  expect(docs[0]?.frontmatter?.title).toBe('After');
});
