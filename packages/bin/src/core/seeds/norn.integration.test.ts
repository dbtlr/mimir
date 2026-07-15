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

    // The `{{seq}}` token allocates next-free — a second create increments.
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

  test('germinate links work nodes idempotently, promotes once, and bumps nothing twice', async () => {
    await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'feature',
      requester: null,
      title: 's',
    });
    await seeds.germinate('MMR', 1, 'MMR-42'); // links + crosses new → promoted
    await seeds.germinate('MMR', 1, 'MMR-42'); // idempotent — already linked + promoted
    await seeds.germinate('MMR', 1, 'MMR-43'); // appends a second link (stays promoted)
    const loaded = await seeds.load('MMR', 1);
    expect(loaded?.spawned).toEqual(['MMR-42', 'MMR-43']);
    expect(loaded?.lifecycle).toBe('promoted');
  });

  test('germinate adds onto a present-but-empty spawned list (raw presence, not decoded)', async () => {
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
    await seeds.germinate('MMR', 1, 'MMR-42');
    const loaded = await seeds.load('MMR', 1);
    expect(loaded?.spawned).toEqual(['MMR-42']);
    expect(loaded?.lifecycle).toBe('promoted');
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

  test('listAll returns every seed in one find, across projects (E1)', async () => {
    await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'a',
    });
    await client.newDoc({
      body: '## Seed Description\n\n\n## History\n## Annotations\n',
      confirm: true,
      field_json: [
        `type=${JSON.stringify('project')}`,
        `key=${JSON.stringify('OTH')}`,
        `name=${JSON.stringify('Other')}`,
      ],
      parents: true,
      path: 'OTH/OTH.md',
    });
    await seeds.create({ description: null, key: 'OTH', kind: 'bug', requester: null, title: 'b' });
    const all = await seeds.listAll();
    expect(all.map((s) => `${s.key}-s${String(s.seq)}`).toSorted()).toEqual(['MMR-s1', 'OTH-s1']);
  });

  test('mutations on an absent seed fail loud', async () => {
    expect(await rejectMessage(() => seeds.patch('MMR', 99, { title: 'x' }))).toMatch(/no seed/);
    expect(await rejectMessage(() => seeds.transition('MMR', 99, 'promoted', 'x'))).toMatch(
      /no seed/,
    );
    expect(await rejectMessage(() => seeds.germinate('MMR', 99, 'MMR-1'))).toMatch(/no seed/);
    expect(await seeds.load('MMR', 99)).toBeUndefined();
  });

  test('a second client adding a collider before targeted resolution fails the read closed', async () => {
    await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'canonical',
    });
    const racer = new NornClient({ vaultPath: join(root, 'vault') });
    const originalGet = client.get.bind(client);
    let injected = false;
    client.get = async (targets: string[], col?: string): Promise<unknown[]> => {
      if (!injected && targets.includes('MMR-s1')) {
        injected = true;
        await racer.newDoc({
          body: 'foreign owner',
          confirm: true,
          field_json: [`type=${JSON.stringify('note')}`],
          parents: true,
          path: 'relocated/MMR-s1.md',
        });
      }
      return originalGet(targets, col);
    };
    try {
      expect(await seeds.load('MMR', 1, { content: true })).toBeUndefined();
      expect(injected).toBe(true);
    } finally {
      await racer.close();
    }
  });

  test('a second client adding a collider before mutation resolution prevents the write', async () => {
    await seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'canonical',
    });
    const racer = new NornClient({ vaultPath: join(root, 'vault') });
    const originalGet = client.get.bind(client);
    let injected = false;
    client.get = async (targets: string[], col?: string): Promise<unknown[]> => {
      if (!injected && targets.includes('MMR-s1')) {
        injected = true;
        await racer.newDoc({
          body: 'foreign owner',
          confirm: true,
          field_json: [`type=${JSON.stringify('note')}`],
          parents: true,
          path: 'relocated/MMR-s1.md',
        });
      }
      return originalGet(targets, col);
    };
    try {
      const message = await rejectMessage(() => seeds.patch('MMR', 1, { title: 'mutated' }));
      expect(message).toMatch(/no seed MMR-s1/);
      const canonical = await client.get(['MMR/seeds/MMR-s1.md']);
      expect(canonical[0]).toMatchObject({ frontmatter: { title: 'canonical' } });
    } finally {
      await racer.close();
    }
  });

  test('a lone non-seed document with a seed-shaped stem is absent and immutable', async () => {
    for (const [seq, type] of [
      [1, 'note'],
      [2, undefined],
    ] as const) {
      const title = type ?? 'untyped';
      await client.newDoc({
        body: '## Seed Description\n\nforeign\n\n## History\n## Annotations\n',
        confirm: true,
        field_json: [
          ...(type === undefined ? [] : [`type=${JSON.stringify(type)}`]),
          `title=${JSON.stringify(title)}`,
          `project=${JSON.stringify('[[MMR]]')}`,
          `kind=${JSON.stringify('idea')}`,
          `lifecycle=${JSON.stringify('new')}`,
          `created=${JSON.stringify('2026-07-13T00:00:00.000Z')}`,
          `updated_at=${JSON.stringify('2026-07-13T00:00:00.000Z')}`,
        ],
        parents: true,
        path: `relocated/MMR-s${String(seq)}.md`,
      });
      expect(await seeds.load('MMR', seq, { content: true })).toBeUndefined();
      expect(await rejectMessage(() => seeds.patch('MMR', seq, { title: 'mutated' }))).toMatch(
        new RegExp(`no seed MMR-s${String(seq)}`),
      );
      expect((await client.get([`relocated/MMR-s${String(seq)}.md`]))[0]).toMatchObject({
        frontmatter: { title },
      });
    }
  });

  test('history and description enforce ambiguity in their one logical section read', async () => {
    await seeds.create({
      description: 'first body',
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'first',
    });
    await seeds.create({
      description: 'second body',
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'second',
    });
    const racer = new NornClient({ vaultPath: join(root, 'vault') });
    const originalResult = client.getSectionsResult.bind(client);
    const injected = new Set<string>();
    const inject = async (targets: string[]): Promise<void> => {
      for (const id of ['MMR-s1', 'MMR-s2']) {
        if (targets.some((target) => target.includes(id)) && !injected.has(id)) {
          injected.add(id);
          await racer.newDoc({
            body: 'no requested seed headings',
            confirm: true,
            field_json: [`type=${JSON.stringify('note')}`],
            parents: true,
            path: `relocated/${id}.md`,
          });
        }
      }
    };
    client.getSectionsResult = async (targets, sections) => {
      await inject(targets);
      return originalResult(targets, sections);
    };
    try {
      expect(await seeds.loadHistory('MMR', 1)).toBeUndefined();
      expect((await seeds.loadDescriptions([{ key: 'MMR', seq: 2 }])).has('MMR-s2')).toBe(false);
      expect([...injected].toSorted()).toEqual(['MMR-s1', 'MMR-s2']);
    } finally {
      await racer.close();
    }
  });

  test('logical section reads reject unique owners that are not valid seeds', async () => {
    for (const [seq, fields] of [
      [1, { kind: 'idea', lifecycle: 'new', type: 'note' }],
      [2, { kind: 'idea', lifecycle: 'new' }],
      [3, { kind: 'foreign', lifecycle: 'new', type: 'seed' }],
      [4, { kind: 'idea', lifecycle: 'foreign', type: 'seed' }],
    ] as const) {
      await client.newDoc({
        body: '## Seed Description\n\nforeign prose\n\n## History\n\n### entry\n\n## Annotations\n',
        confirm: true,
        field_json: [
          ...('type' in fields ? [`type=${JSON.stringify(fields.type)}`] : []),
          `title=${JSON.stringify('foreign')}`,
          `project=${JSON.stringify('[[MMR]]')}`,
          `kind=${JSON.stringify(fields.kind)}`,
          `lifecycle=${JSON.stringify(fields.lifecycle)}`,
          `created=${JSON.stringify('2026-07-13T00:00:00.000Z')}`,
          `updated_at=${JSON.stringify('2026-07-13T00:00:00.000Z')}`,
        ],
        parents: true,
        path: `relocated/MMR-s${String(seq)}.md`,
      });
    }
    for (const seq of [1, 2, 3, 4]) {
      expect(await seeds.loadHistory('MMR', seq)).toBeUndefined();
    }
    expect(await seeds.loadDescriptions([1, 2, 3, 4].map((seq) => ({ key: 'MMR', seq })))).toEqual(
      new Map(),
    );
  });

  test('listForProject resolves physical owners only for decoded records in that project', async () => {
    const fakeDocs = Array.from({ length: 2_010 }, (_, index) => {
      const key = index < 10 ? 'MMR' : 'OTH';
      const seq = index < 10 ? index + 1 : index - 9;
      return {
        frontmatter: {
          created: '2026-07-13T00:00:00.000Z',
          kind: 'idea',
          lifecycle: 'new',
          project: `[[${key}]]`,
          title: `${key} ${String(seq)}`,
          type: 'seed',
          updated_at: '2026-07-13T00:00:00.000Z',
        },
        path: `${key}/seeds/${key}-s${String(seq)}.md`,
      };
    });
    let targets: string[] = [];
    client.find = () => Promise.resolve(fakeDocs);
    client.get = (requested) => {
      targets = requested;
      const wanted = new Set(requested);
      return Promise.resolve(
        fakeDocs.filter((doc) => wanted.has(doc.path.split('/').at(-1)?.slice(0, -3) ?? '')),
      );
    };
    const scoped = createNornSeedStore(client, join(root, 'vault'));
    expect(await scoped.listForProject('MMR')).toHaveLength(10);
    expect(targets).toHaveLength(10);
  });

  test('listForProject decodes the final bare-stem resolution, not the stale find rows', async () => {
    const initial = [1, 2, 3].map((seq) => ({
      frontmatter: {
        created: '2026-07-13T00:00:00.000Z',
        kind: 'idea',
        lifecycle: 'new',
        title: `stale ${String(seq)}`,
        type: 'seed',
        updated_at: '2026-07-13T00:00:00.000Z',
      },
      path: `MMR/seeds/MMR-s${String(seq)}.md`,
    }));
    client.find = () => Promise.resolve(initial);
    client.get = () =>
      Promise.resolve([
        { ...initial[0], frontmatter: { ...initial[0]?.frontmatter, title: 'fresh' } },
        { ...initial[1], frontmatter: { ...initial[1]?.frontmatter, type: 'note' } },
        { ...initial[2], frontmatter: { ...initial[2]?.frontmatter, kind: 'foreign' } },
      ]);
    const scoped = createNornSeedStore(client, join(root, 'vault'));
    expect((await scoped.listForProject('MMR')).map(({ seq, title }) => ({ seq, title }))).toEqual([
      { seq: 1, title: 'fresh' },
    ]);
  });
});
