import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from '../../exec';
import { converge } from '../../vault/converge';
import { createInitiative, createProject, createTask } from '../create';
import type { StoreExport } from '../export';
import type { Store } from '../store';
import { NornClient } from './client';
import { seedRawDoc } from './testing';
import { exportNornStore, importNornStore } from './transfer';
import { createNornWriteStore } from './writer';

/**
 * Export/import batching against a real `norn` subprocess (MMR-378). The
 * byte-bounded batching exists because the MCP transport silently drops an
 * oversized response (NRN-s30, see ./chunking) — a fault that only shows on a
 * vault far larger than a test fixture. So the chunking is pinned by INJECTING a
 * budget small enough to force one document per call, and asserting both that
 * the calls actually fan out and that the result is identical to the unbatched
 * one. A budget bug then fails here rather than on the operator's vault.
 */
const NORN = Bun.which('norn') !== null;

setDefaultTimeout(60_000);

/** One target per call — the smallest batching a budget can express. */
const ONE_PER_CALL = { budget: 1, ceiling: 1 };

type Counts = { get: number; getSections: number; applyPlan: number };

/** Wrap a client's batched calls with a counter, leaving behavior untouched. */
function countCalls(client: NornClient): Counts {
  const counts: Counts = { applyPlan: 0, get: 0, getSections: 0 };
  const realGet = client.get.bind(client);
  const realGetSections = client.getSections.bind(client);
  const realApplyPlan = client.applyPlan.bind(client);
  client.get = (targets, col) => {
    counts.get += 1;
    return realGet(targets, col);
  };
  client.getSections = (targets, sections) => {
    counts.getSections += 1;
    return realGetSections(targets, sections);
  };
  client.applyPlan = (plan, confirm) => {
    counts.applyPlan += 1;
    return realApplyPlan(plan, confirm);
  };
  return counts;
}

/** Everything but the stamp — the part of an export that must be reproducible. */
function withoutStamp(document: StoreExport): Omit<StoreExport, 'exported_at'> {
  const { exported_at: _stamp, ...rest } = document;
  return rest;
}

let root: string;
let sourceVault: string;
let targetVault: string;
let sourceClient: NornClient;
let targetClient: NornClient;
let source: Store;

beforeEach(async () => {
  if (!NORN) {
    return;
  }
  root = mkdtempSync(join(tmpdir(), 'mimir-transfer-'));
  sourceVault = join(root, 'source');
  targetVault = join(root, 'target');
  await converge(sourceVault, { allowCreate: true, exec: bunExec });
  await converge(targetVault, { allowCreate: true, exec: bunExec });
  sourceClient = new NornClient({ vaultPath: sourceVault });
  targetClient = new NornClient({ vaultPath: targetVault });
  source = createNornWriteStore(sourceClient, sourceVault);

  await createProject(source, { description: null, key: 'MMR', name: 'Mimir' });
  const initiative = await createInitiative(source, { projectId: 'MMR', title: 'Bridge' });
  await createTask(source, { parentId: initiative.id, title: 'Export' });
  for (let n = 0; n < 4; n += 1) {
    await source.artifacts.create({
      content: `# artifact ${String(n)}\n\n${'body '.repeat(200)}`,
      key: 'MMR',
      links: [],
      tags: [],
      title: `Artifact ${String(n)}`,
    });
    await source.seeds.create({
      description: `seed prose ${String(n)}`,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: `Seed ${String(n)}`,
    });
    await source.scratchpads.create({
      agenda: [],
      anchors: [],
      createdAt: '2026-09-01T12:00:00.000Z',
      freezingAt: null,
      id: `123e4567-e89b-42d3-a456-42661417400${String(n)}`,
      journal: [{ at: '2026-09-01T12:00:00.000Z', content: 'journal '.repeat(200), number: 1 }],
      project: 'MMR',
      title: `Pad ${String(n)}`,
      updatedAt: '2026-09-01T12:00:00.000Z',
    });
  }
});

afterEach(async () => {
  if (!NORN) {
    return;
  }
  await sourceClient.close();
  await targetClient.close();
  rmSync(root, { force: true, recursive: true });
});

test.skipIf(!NORN)('export fans body reads out across chunks and is budget-invariant', async () => {
  const unbatched = await exportNornStore(sourceClient);
  expect(unbatched.artifacts).toHaveLength(4);
  expect(unbatched.seeds).toHaveLength(4);
  expect(unbatched.scratchpads).toHaveLength(4);

  const counts = countCalls(sourceClient);
  const chunked = await exportNornStore(sourceClient, ONE_PER_CALL);

  // One `vault.get` per artifact, seed, and SCRATCHPAD body, and one section
  // read per stem (the project, the initiative, the task) — no whole-set body
  // read left anywhere in the export, the scratchpad collection included: a pad
  // body is a whole journal, and the whole-vault set in one `find` with `.body`
  // is what closes the MCP connection on a real vault (NRN-s30).
  expect(counts.get).toBeGreaterThanOrEqual(12);
  expect(counts.getSections).toBeGreaterThanOrEqual(3);
  // Same document either way: batching is a transport concern, never a content one.
  expect(withoutStamp(chunked)).toEqual(withoutStamp(unbatched));
});

test.skipIf(!NORN)('import writes in byte-bounded plans and round-trips unchanged', async () => {
  const document = await exportNornStore(sourceClient);
  const counts = countCalls(targetClient);
  const report = await importNornStore(
    targetClient,
    targetVault,
    document,
    { mode: 'fresh' },
    { write: ONE_PER_CALL },
  );

  // One plan per document, rather than one plan for the whole import.
  expect(report.created).toBeGreaterThan(8);
  expect(counts.applyPlan).toBe(report.created);

  const target = createNornWriteStore(targetClient, targetVault);
  expect(withoutStamp(await target.export())).toEqual(withoutStamp(document));
});

test.skipIf(!NORN)(
  'an import copies a degraded document through, it does not heal it',
  async () => {
    // A legacy artifact predating `updated_at` (MMR-317): the tolerant read yields
    // `''`, and the target must read `''` too. Inventing a stamp would silently
    // "repair" a document whose repair is `mimir doctor --fix`'s call (ADR 0017),
    // and would make the round trip visible.
    await seedRawDoc(sourceClient, sourceVault, 'MMR/artifacts/MMR-a9.md', {
      created: '2026-01-01T00:00:00.000Z',
      project: '[[MMR]]',
      title: 'Legacy',
      type: 'artifact',
    });

    const document = await exportNornStore(sourceClient);
    const legacy = document.artifacts.find((artifact) => artifact.seq === 9);
    expect(legacy?.updated_at).toBe('');

    await importNornStore(targetClient, targetVault, document, { mode: 'fresh' });
    const target = createNornWriteStore(targetClient, targetVault);
    expect((await target.artifacts.load('MMR', 9))?.updated_at).toBe('');
  },
);

test.skipIf(!NORN)('a resume reads the target in chunks and skips every document', async () => {
  const document = await exportNornStore(sourceClient);
  const first = await importNornStore(targetClient, targetVault, document, { mode: 'fresh' });

  const counts = countCalls(targetClient);
  const resumed = await importNornStore(
    targetClient,
    targetVault,
    document,
    { mode: 'resume' },
    { read: ONE_PER_CALL },
  );

  expect(resumed).toEqual({ created: 0, mode: 'resume', skipped: first.created });
  // The presence probe is chunked too: one read per imported document.
  expect(counts.get).toBe(first.created);
  // Nothing written, so no plan was applied at all.
  expect(counts.applyPlan).toBe(0);
});
