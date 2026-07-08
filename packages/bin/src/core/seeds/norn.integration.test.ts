import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from '../../exec';
import { NornClient } from '../../norn/client';
import { pathAndSections } from '../../norn/decode';
import { converge } from '../../vault/converge';
import {
  HISTORY_HEADING,
  parseHistorySection,
  sectionBody,
} from '../history-codec';
import { createNornSeedStore } from './norn';
import type { SeedStore } from './store';

/**
 * The Norn seed store (MMR-244) against a real converged vault. Needs a `norn`
 * binary; skipped when it is off PATH (CI). A seed doc lives at
 * `KEY/seeds/KEY-sN.md`, sibling of `KEY/artifacts/`.
 */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
let seeds: SeedStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-seed-'));
  const vault = join(root, 'vault');
  await converge(vault, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vault });
  seeds = createNornSeedStore(client, vault);
});

afterEach(async () => {
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

describe.skipIf(!NORN)('norn seed store', () => {
  test('create derives KEY-sN seq and round-trips the record + body sections', async () => {
    const first = await seeds.create({
      description: 'a rough idea',
      key: 'MMR',
      kind: 'feature',
      requester: null,
      title: 'seed one',
    });
    expect(first).toEqual({ key: 'MMR', seq: 1 });

    // Derived max(seq)+1 — a second create increments.
    const second = await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'bug',
      requester: 'AB',
      title: 'seed two',
    });
    expect(second).toEqual({ key: 'MMR', seq: 2 });

    const loaded = await seeds.load('MMR', 1, { content: true });
    expect(loaded).toMatchObject({
      description: 'a rough idea',
      key: 'MMR',
      kind: 'feature',
      lifecycle: 'new',
      requester: null,
      seq: 1,
      spawned: [],
      title: 'seed one',
    });

    // requester is a project key (stored as a wikilink, collapsed on read).
    const withRequester = await seeds.load('MMR', 2);
    expect(withRequester?.requester).toBe('AB');
    expect(withRequester?.kind).toBe('bug');

    // The body carries the full sectioned shape with empty History to append under.
    const records = await client.getSections(['MMR/seeds/MMR-s1.md'], [HISTORY_HEADING]);
    const raw = pathAndSections(records[0])?.sections[HISTORY_HEADING] ?? '';
    expect(parseHistorySection(sectionBody(raw))).toEqual([]);
  });

  test('listForProject returns the inventory seq-ascending', async () => {
    await seeds.create({ description: null, key: 'MMR', kind: 'idea', requester: null, title: 'a' });
    await seeds.create({ description: null, key: 'MMR', kind: 'idea', requester: null, title: 'b' });
    const list = await seeds.listForProject('MMR');
    expect(list.map((s) => s.seq)).toEqual([1, 2]);
    expect(list.map((s) => s.title)).toEqual(['a', 'b']);
  });

  test('patch edits a live seed and refuses a terminal one', async () => {
    await seeds.create({ description: 'old', key: 'MMR', kind: 'idea', requester: null, title: 'x' });
    await seeds.patch('MMR', 1, { description: 'new prose', kind: 'bug', title: 'renamed' });
    const patched = await seeds.load('MMR', 1, { content: true });
    expect(patched).toMatchObject({ description: 'new prose', kind: 'bug', title: 'renamed' });

    await seeds.transition('MMR', 1, 'resolved', 'already fixed');
    await expect(seeds.patch('MMR', 1, { title: 'nope' })).rejects.toThrow(/frozen/);
  });

  test('transition records History and enforces the lifecycle machine', async () => {
    await seeds.create({ description: null, key: 'MMR', kind: 'feature', requester: null, title: 't' });
    await seeds.transition('MMR', 1, 'promoted', 'worth cultivating');
    await seeds.transition('MMR', 1, 'resolved', 'shipped');

    const resolved = await seeds.load('MMR', 1);
    expect(resolved?.lifecycle).toBe('resolved');

    const records = await client.getSections(['MMR/seeds/MMR-s1.md'], [HISTORY_HEADING]);
    const raw = pathAndSections(records[0])?.sections[HISTORY_HEADING] ?? '';
    const history = parseHistorySection(sectionBody(raw));
    expect(history).toEqual([
      { at: expect.any(String), from: 'new', kind: 'lifecycle', reason: 'worth cultivating', to: 'promoted' },
      { at: expect.any(String), from: 'promoted', kind: 'lifecycle', reason: 'shipped', to: 'resolved' },
    ]);

    // A terminal seed refuses further transitions; an illegal edge is refused too.
    await expect(seeds.transition('MMR', 1, 'rejected', 'x')).rejects.toThrow(/cannot move/);
  });

  test('an illegal edge from new is refused (new → new)', async () => {
    await seeds.create({ description: null, key: 'MMR', kind: 'idea', requester: null, title: 'q' });
    await expect(seeds.transition('MMR', 1, 'new', 'x')).rejects.toThrow(/cannot move/);
  });

  test('appendSpawned links work nodes idempotently and bumps nothing twice', async () => {
    await seeds.create({ description: null, key: 'MMR', kind: 'feature', requester: null, title: 's' });
    await seeds.appendSpawned('MMR', 1, 'MMR-42');
    await seeds.appendSpawned('MMR', 1, 'MMR-42'); // idempotent
    await seeds.appendSpawned('MMR', 1, 'MMR-43');
    const loaded = await seeds.load('MMR', 1);
    expect(loaded?.spawned).toEqual(['MMR-42', 'MMR-43']);
  });

  test('mutations on an absent seed fail loud', async () => {
    await expect(seeds.patch('MMR', 99, { title: 'x' })).rejects.toThrow(/no seed/);
    await expect(seeds.transition('MMR', 99, 'promoted', 'x')).rejects.toThrow(/no seed/);
    await expect(seeds.appendSpawned('MMR', 99, 'MMR-1')).rejects.toThrow(/no seed/);
    expect(await seeds.load('MMR', 99)).toBeUndefined();
  });
});
