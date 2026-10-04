import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SEED_LANE_VALUES, STATUS_WORD_VALUES } from '@mimir/contract';
import type { Lane } from '@mimir/contract';

import { deriveSet, isStale, listSeeds, nodeStatusWord } from '../src/core';
import type { Store } from '../src/core';
import { attentionOf } from '../src/core/attention';
import type { Node } from '../src/core/model';
import { seedLane } from '../src/core/seeds';
import type { BuiltStore } from '../src/store-backend';
import { buildSqliteStore } from '../src/store-sqlite-backend';
import { generateDocsFixture } from './generate-docs-fixture';

/**
 * The docs fixture generator (MMR-421): generate into a temp SQLite file, then
 * assert through the READ/derive surface that every visual state the
 * screenshots rely on actually manifests.
 */
let root: string;
let built: BuiltStore;
let store: Store;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-fixture-'));
  const file = join(root, 'docs.sqlite');
  await generateDocsFixture(file);
  built = await buildSqliteStore(file);
  store = built.store;
}, 60_000);

afterAll(async () => {
  try {
    await built?.close();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

const byTitle = (nodes: readonly Node[], title: string): Node => {
  const node = nodes.find((n) => n.title === title);
  if (node === undefined) {
    throw new Error(`no node titled "${title}"`);
  }
  return node;
};

test('every Status word manifests somewhere in the store', async () => {
  const ws = await store.loadWorkingSet();
  const set = deriveSet(ws);
  const words = new Set(ws.nodes.map((n) => nodeStatusWord(set, n)));
  for (const word of STATUS_WORD_VALUES) {
    expect(words.has(word)).toBe(true);
  }
});

test('the backdated cohort reads as stale', async () => {
  const ws = await store.loadWorkingSet();
  const set = deriveSet(ws);
  // The two Beacon leaves were created ~20 days back (past the 14-day threshold).
  const backfill = byTitle(ws.nodes, 'Backfill the event schema to v2');
  const partition = byTitle(ws.nodes, 'Partition the cold store by tenant');
  expect(isStale(set, backfill)).toBe(true); // stale in_progress
  expect(isStale(set, partition)).toBe(true); // stale ready
  // And a fresh Aurora leaf is NOT stale — proving the freeze/restore boundary.
  expect(isStale(set, byTitle(ws.nodes, 'Cache the home feed locally'))).toBe(false);
});

test('every attention lane is populated across the projects', async () => {
  const ws = await store.loadWorkingSet();
  const set = deriveSet(ws);
  const lanes = new Set<Lane>(ws.projects.map((p) => attentionOf(set, p).lane));
  for (const lane of ['awaiting_you', 'live', 'needs_unsticking', 'at_rest'] as const) {
    expect(lanes.has(lane)).toBe(true);
  }
});

test('the documentation portfolio includes an archived project', async () => {
  const ws = await store.loadWorkingSet();
  const ember = ws.projects.find((project) => project.key === 'EMB');
  expect(ember).toBeDefined();
  expect(ember?.archived_at).not.toBeNull();
});

test('seeds are present in all four lanes', async () => {
  const views = await listSeeds(store, { status: 'all' });
  const lanes = new Set(views.map((v) => seedLane(v)));
  for (const lane of SEED_LANE_VALUES) {
    expect(lanes.has(lane)).toBe(true);
  }
});

test('the idle and active open-ended homes read correctly', async () => {
  const ws = await store.loadWorkingSet();
  const set = deriveSet(ws);
  // Idle open-ended (empty) reads `ready` via the transparency coercion (MMR-204).
  expect(nodeStatusWord(set, byTitle(ws.nodes, 'Polish'))).toBe('ready');
  // Active open-ended (a live child) reads its rollup.
  expect(nodeStatusWord(set, byTitle(ws.nodes, 'Bug Bash'))).toBe('in_progress');
});

test('the dependency chain, tags, and artifacts manifest', async () => {
  const ws = await store.loadWorkingSet();
  // The deep-linking task awaits the carousel task — one edge in the graph.
  const carousel = byTitle(ws.nodes, 'Wire up the welcome carousel');
  const deepLink = byTitle(ws.nodes, 'Route universal links to screens');
  expect(ws.edges).toContainEqual({ depends_on_node_id: carousel.id, node_id: deepLink.id });

  // Node + project tags.
  expect((ws.nodeTags.get(carousel.id) ?? []).map((t) => t.tag)).toContain('area:onboarding');
  const aurora = ws.projects.find((p) => p.key === 'AUR');
  expect(aurora).toBeDefined();
  expect((ws.projectTags.get(aurora?.key ?? '') ?? []).map((t) => t.tag)).toContain('release:v1');

  // A task-linked artifact and a project-level one.
  const artifacts = await store.artifacts.listForProject('AUR');
  expect(artifacts.length).toBe(4);
  expect(artifacts.some((a) => a.links.length > 0)).toBe(true);
  expect(artifacts.some((a) => a.links.length === 0)).toBe(true);
});

// ── The target guard: only a previous fixture is ever replaced ─────────────

/** Run the generator expecting a refusal; returns the thrown message.
 * try/catch avoids the await-thenable lint on `.rejects.toThrow` (repo
 * convention) and guarantees the refusal lands before the caller inspects
 * the file. */
async function refusalOf(target: string): Promise<string> {
  try {
    await generateDocsFixture(target);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the generator to refuse');
}

test('regenerating over a previous fixture replaces it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-fixture-guard-'));
  try {
    const file = join(dir, 'docs.sqlite');
    await generateDocsFixture(file);
    const summary = await generateDocsFixture(file);
    expect(summary.projects).toEqual(['AUR', 'BCN', 'CIR', 'DLT', 'EMB']);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}, 60_000);

test('refuses a store holding a project the fixture does not own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-fixture-guard-'));
  try {
    const file = join(dir, 'store.sqlite');
    const real = await buildSqliteStore(file);
    try {
      await real.store.transact((writer) =>
        writer.insertProject({ description: null, key: 'MMR', name: 'Mimir', tags: [] }),
      );
    } finally {
      await real.close();
    }
    expect(await refusalOf(file)).toMatch(/refusing to replace it/);
    const after = await buildSqliteStore(file);
    try {
      expect((await after.store.loadProjects()).map((p) => p.key)).toEqual(['MMR']);
    } finally {
      await after.close();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('refuses a file that is not a SQLite store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-fixture-guard-'));
  try {
    const file = join(dir, 'notes.md');
    writeFileSync(file, 'irreplaceable\n');
    expect(await refusalOf(file)).toMatch(/refusing to replace it/);
    expect(readFileSync(file, 'utf8')).toBe('irreplaceable\n');
    expect(existsSync(`${file}-wal`)).toBe(false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
