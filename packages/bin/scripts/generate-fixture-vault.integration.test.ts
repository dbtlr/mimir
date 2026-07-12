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
import { NornClient } from '../src/norn/client';
import { createNornWriteStore } from '../src/norn/writer';
import { generateFixtureVault } from './generate-fixture-vault';

/**
 * The fixture vault generator over a real `norn` subprocess (MMR-255): generate
 * into a temp dir, then assert through the READ/derive surface that every visual
 * state the smokes rely on actually manifests. Skipped when the binary isn't on
 * PATH (same convention as store-norn.integration.test.ts).
 */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
let store: Store;

beforeAll(async () => {
  if (!NORN) {
    return;
  }
  root = mkdtempSync(join(tmpdir(), 'mimir-fixture-'));
  const vault = join(root, 'vault');
  await generateFixtureVault(vault);
  client = new NornClient({ vaultPath: vault });
  store = createNornWriteStore(client, vault);
  // Generating the full demo vault is many norn transacts — well past bun's
  // 5s default hook timeout on a cold CI runner (the suite only started
  // running in CI when MMR-234 provisioned norn there).
}, 120_000);

afterAll(async () => {
  // `client` can be unassigned when norn is absent OR when beforeAll timed
  // out mid-generation — guard both rather than gating on NORN alone.
  await client?.close();
  if (root !== undefined) {
    rmSync(root, { force: true, recursive: true });
  }
}, 30_000);

const byTitle = (nodes: readonly Node[], title: string): Node => {
  const node = nodes.find((n) => n.title === title);
  if (node === undefined) {
    throw new Error(`no node titled "${title}"`);
  }
  return node;
};

test.skipIf(!NORN)('every Status word manifests somewhere in the vault', async () => {
  const ws = await store.loadWorkingSet();
  const set = deriveSet(ws);
  const words = new Set(ws.nodes.map((n) => nodeStatusWord(set, n)));
  for (const word of STATUS_WORD_VALUES) {
    expect(words.has(word)).toBe(true);
  }
});

test.skipIf(!NORN)('the backdated cohort reads as stale', async () => {
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

test.skipIf(!NORN)('every attention lane is populated across the projects', async () => {
  const ws = await store.loadWorkingSet();
  const set = deriveSet(ws);
  const lanes = new Set<Lane>(ws.projects.map((p) => attentionOf(set, p).lane));
  for (const lane of ['awaiting_you', 'live', 'needs_unsticking', 'at_rest'] as const) {
    expect(lanes.has(lane)).toBe(true);
  }
});

test.skipIf(!NORN)('seeds are present in all four lanes', async () => {
  const views = await listSeeds(store, { status: 'all' });
  const lanes = new Set(views.map((v) => seedLane(v)));
  for (const lane of SEED_LANE_VALUES) {
    expect(lanes.has(lane)).toBe(true);
  }
});

test.skipIf(!NORN)('the idle and active open-ended homes read correctly', async () => {
  const ws = await store.loadWorkingSet();
  const set = deriveSet(ws);
  // Idle open-ended (empty) reads `ready` via the transparency coercion (MMR-204).
  expect(nodeStatusWord(set, byTitle(ws.nodes, 'Polish'))).toBe('ready');
  // Active open-ended (a live child) reads its rollup.
  expect(nodeStatusWord(set, byTitle(ws.nodes, 'Bug Bash'))).toBe('in_progress');
});

test.skipIf(!NORN)('the dependency chain, tags, and artifacts manifest', async () => {
  const ws = await store.loadWorkingSet();
  // The deep-linking task awaits the carousel task — one edge in the graph.
  const carousel = byTitle(ws.nodes, 'Wire up the welcome carousel');
  const deepLink = byTitle(ws.nodes, 'Route universal links to screens');
  expect(ws.edges).toContainEqual({ depends_on_node_id: carousel.id, node_id: deepLink.id });

  // Node + project tags.
  expect((ws.nodeTags.get(carousel.id) ?? []).map((t) => t.tag)).toContain('area:onboarding');
  const aurora = ws.projects.find((p) => p.key === 'AUR');
  expect(aurora).toBeDefined();
  expect((ws.projectTags.get(aurora?.id ?? -1) ?? []).map((t) => t.tag)).toContain('release:v1');

  // A task-linked artifact and a project-level one.
  const artifacts = await store.artifacts.listForProject('AUR');
  expect(artifacts.length).toBe(2);
  expect(artifacts.some((a) => a.links.length > 0)).toBe(true);
  expect(artifacts.some((a) => a.links.length === 0)).toBe(true);
});

// ── The target guard (needs no norn: it refuses before any vault work) ──────

/** Run the generator expecting a refusal; returns the thrown message.
 * try/catch avoids the await-thenable lint on `.rejects.toThrow` (repo
 * convention) and guarantees the refusal lands before the caller inspects
 * the directory. */
async function refusalOf(target: string): Promise<string> {
  try {
    await generateFixtureVault(target);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the generator to refuse');
}

test('refuses a real marked vault that lacks the fixture sentinel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-fixture-guard-'));
  try {
    // A directory that LOOKS like a real vault: the standard marker, no sentinel.
    writeFileSync(join(dir, '.mimir-vault.toml'), 'schema = 4\n');
    writeFileSync(join(dir, 'notes.md'), 'irreplaceable\n');
    expect(await refusalOf(dir)).toMatch(/refusing to touch it/);
    // Nothing was deleted.
    expect(existsSync(join(dir, '.mimir-vault.toml'))).toBe(true);
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('irreplaceable\n');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('refuses a regular-file target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-fixture-guard-'));
  try {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'plain file\n');
    expect(await refusalOf(file)).toMatch(/is a file, not a directory/);
    expect(readFileSync(file, 'utf8')).toBe('plain file\n'); // untouched
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
