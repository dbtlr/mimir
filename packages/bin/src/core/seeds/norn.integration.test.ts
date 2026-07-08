import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from '../../exec';
import { NornClient } from '../../norn/client';
import { pathAndSections } from '../../norn/decode';
import { converge } from '../../vault/converge';
import { HISTORY_HEADING, parseHistorySection, sectionBody } from '../history-codec';
import { readVaultGraph } from '../store-norn';
import { validate } from '../validate';
import { createNornSeedStore } from './norn';
import type { SeedStore } from './store';

/**
 * The Norn seed store (MMR-244) against a real converged vault. Needs a `norn`
 * binary; skipped when it is off PATH (CI). A seed doc lives at
 * `KEY/seeds/KEY-sN.md`, sibling of `KEY/artifacts/`.
 */
const NORN = Bun.which('norn') !== null;

/** Run `fn`, returning the rejection's message; throws if it did not reject. */
async function rejectMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a rejection, but the call resolved');
}

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

  test('load content reads the record + description in one body read (multi-paragraph, escaped heading)', async () => {
    // The description carries a paragraph break AND a heading-shaped line; the
    // content load slices the `## Seed Description` section from the whole body
    // locally, so it must round-trip exactly (the escaped heading stays prose, the
    // slice stops before `## History`) — the one-RPC path (MMR-244 review).
    const description = 'first paragraph\n\nsecond paragraph\n## Heading-shaped line';
    await seeds.create({ description, key: 'MMR', kind: 'feature', requester: null, title: 't' });
    const loaded = await seeds.load('MMR', 1, { content: true });
    expect(loaded?.description).toBe(description);
    // Metadata-only omits the description entirely (no body read).
    const meta = await seeds.load('MMR', 1);
    expect(meta).toBeDefined();
    expect('description' in (meta ?? {})).toBe(false);
  });

  test('listForProject returns the inventory seq-ascending', async () => {
    await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'a',
    });
    await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'b',
    });
    const list = await seeds.listForProject('MMR');
    expect(list.map((s) => s.seq)).toEqual([1, 2]);
    expect(list.map((s) => s.title)).toEqual(['a', 'b']);
  });

  test('patch edits a live seed and refuses a terminal one', async () => {
    await seeds.create({
      description: 'old',
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'x',
    });
    await seeds.patch('MMR', 1, { description: 'new prose', kind: 'bug', title: 'renamed' });
    const patched = await seeds.load('MMR', 1, { content: true });
    expect(patched).toMatchObject({ description: 'new prose', kind: 'bug', title: 'renamed' });

    await seeds.transition('MMR', 1, 'resolved', 'already fixed');
    expect(await rejectMessage(() => seeds.patch('MMR', 1, { title: 'nope' }))).toMatch(/frozen/);
  });

  test('transition records History and enforces the lifecycle machine', async () => {
    await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'feature',
      requester: null,
      title: 't',
    });
    await seeds.transition('MMR', 1, 'promoted', 'worth cultivating');
    await seeds.transition('MMR', 1, 'resolved', 'shipped');

    const resolved = await seeds.load('MMR', 1);
    expect(resolved?.lifecycle).toBe('resolved');

    const records = await client.getSections(['MMR/seeds/MMR-s1.md'], [HISTORY_HEADING]);
    const raw = pathAndSections(records[0])?.sections[HISTORY_HEADING] ?? '';
    const history = parseHistorySection(sectionBody(raw));
    expect(history).toEqual([
      {
        at: expect.any(String),
        from: 'new',
        kind: 'lifecycle',
        reason: 'worth cultivating',
        to: 'promoted',
      },
      {
        at: expect.any(String),
        from: 'promoted',
        kind: 'lifecycle',
        reason: 'shipped',
        to: 'resolved',
      },
    ]);

    // A terminal seed refuses further transitions; an illegal edge is refused too.
    expect(await rejectMessage(() => seeds.transition('MMR', 1, 'rejected', 'x'))).toMatch(
      /cannot move/,
    );
  });

  test('an illegal edge from new is refused (new → new)', async () => {
    await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'q',
    });
    expect(await rejectMessage(() => seeds.transition('MMR', 1, 'new', 'x'))).toMatch(
      /cannot move/,
    );
  });

  test('appendSpawned links work nodes idempotently and bumps nothing twice', async () => {
    await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'feature',
      requester: null,
      title: 's',
    });
    await seeds.appendSpawned('MMR', 1, 'MMR-42');
    await seeds.appendSpawned('MMR', 1, 'MMR-42'); // idempotent
    await seeds.appendSpawned('MMR', 1, 'MMR-43');
    const loaded = await seeds.load('MMR', 1);
    expect(loaded?.spawned).toEqual(['MMR-42', 'MMR-43']);
  });

  test('appendSpawned adds onto a present-but-empty spawned list (raw presence, not decoded)', async () => {
    // A hand-written seed carrying `spawned: []` (present but empty). The decoded
    // record's list is empty, but the FIELD is present — so the first append must
    // SET it (carrying the CAS old value), not ADD it: norn refuses to add a field
    // that already exists, so the decoded-length check would throw.
    await client.newDoc({
      body: '## Seed Description\n\n\n## History\n## Annotations\n',
      confirm: true,
      field_json: [
        `type=${JSON.stringify('seed')}`,
        `title=${JSON.stringify('hand')}`,
        `project=${JSON.stringify('[[MMR]]')}`,
        `kind=${JSON.stringify('idea')}`,
        `lifecycle=${JSON.stringify('new')}`,
        `spawned=${JSON.stringify([])}`,
        `created=${JSON.stringify('2026-07-08T00:00:00.000Z')}`,
        `updated_at=${JSON.stringify('2026-07-08T00:00:00.000Z')}`,
      ],
      parents: true,
      path: 'MMR/seeds/MMR-s1.md',
    });
    await seeds.appendSpawned('MMR', 1, 'MMR-42');
    const loaded = await seeds.load('MMR', 1);
    expect(loaded?.spawned).toEqual(['MMR-42']);
  });

  test('readVaultGraph surfaces seeds so validate/doctor drops a foreign-kind seed', async () => {
    // A valid seed via the store, plus a hand-corrupt one written raw (the store's
    // typed API can't produce a foreign kind) — readVaultGraph must load both.
    await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'ok',
    });
    await client.newDoc({
      body: '## Seed Description\n\n\n## History\n## Annotations\n',
      confirm: true,
      field_json: [
        `type=${JSON.stringify('seed')}`,
        `title=${JSON.stringify('bad')}`,
        `project=${JSON.stringify('[[MMR]]')}`,
        `kind=${JSON.stringify('chore')}`,
        `lifecycle=${JSON.stringify('new')}`,
        `created=${JSON.stringify('2026-07-08T00:00:00.000Z')}`,
        `updated_at=${JSON.stringify('2026-07-08T00:00:00.000Z')}`,
      ],
      parents: true,
      path: 'MMR/seeds/MMR-s2.md',
    });

    const graph = await readVaultGraph(client);
    expect(graph.seeds?.map((s) => s.stem).toSorted()).toEqual(['MMR-s1', 'MMR-s2']);
    const { dropped } = validate(graph);
    expect(dropped).toContainEqual({
      key: 'MMR',
      kind: 'node',
      rule: 'invalid-seed-kind',
      stem: 'MMR-s2',
      value: 'chore',
    });
  });

  test('mutations on an absent seed fail loud', async () => {
    expect(await rejectMessage(() => seeds.patch('MMR', 99, { title: 'x' }))).toMatch(/no seed/);
    expect(await rejectMessage(() => seeds.transition('MMR', 99, 'promoted', 'x'))).toMatch(
      /no seed/,
    );
    expect(await rejectMessage(() => seeds.appendSpawned('MMR', 99, 'MMR-1'))).toMatch(/no seed/);
    expect(await seeds.load('MMR', 99)).toBeUndefined();
  });
});
