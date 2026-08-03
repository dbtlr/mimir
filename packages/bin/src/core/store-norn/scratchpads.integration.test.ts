import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Scratchpad } from '@mimir/contract';

import { bunExec } from '../../exec';
import { converge } from '../../vault/converge';
import { NornClient } from './client';
import { createNornScratchpadStore } from './scratchpads';
import { seedRawDoc } from './testing';

const NORN = Bun.which('norn') !== null;
const CREATED = '2026-08-03T12:00:00.000Z';
const UPDATED = '2026-08-03T12:05:00.000Z';
const ID = '123e4567-e89b-42d3-a456-426614174000';
const CORRUPT_ID = '223e4567-e89b-42d3-a456-426614174000';

setDefaultTimeout(20_000);

let root: string;
let vaultRoot: string;
let client: NornClient;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-scratchpad-'));
  vaultRoot = join(root, 'vault');
  await converge(vaultRoot, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vaultRoot });
  await seedRawDoc(client, vaultRoot, 'MMR/MMR.md', {
    created: CREATED,
    key: 'MMR',
    name: 'Mimir',
    type: 'project',
    updated_at: CREATED,
  });
});

afterEach(async () => {
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

function scratchpad(id: string): Scratchpad {
  return {
    agenda: [{ content: 'Settle persistence', number: 1, reason: null, state: 'open' }],
    anchors: [],
    createdAt: CREATED,
    freezingAt: null,
    id,
    journal: [{ at: CREATED, content: 'Started.', number: 1 }],
    project: 'MMR',
    title: 'Persistence proof',
    updatedAt: CREATED,
  };
}

async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(pattern);
}

test.skipIf(!NORN)(
  'real Norn persists exact Scratchpad lifecycle and quarantines corrupt body without rewriting it',
  async () => {
    const store = createNornScratchpadStore(client, vaultRoot);
    const created = scratchpad(ID);

    await expectRejection(
      store.create({
        ...scratchpad('323e4567-e89b-42d3-a456-426614174000'),
        agenda: [{ content: 'Invalid', number: 1, reason: null, state: 'superseded' }],
      }),
      /Agenda state/,
    );

    await store.create(created);
    expect(await store.load(ID)).toEqual(created);
    expect(await store.load(ID.slice(0, 8))).toBeUndefined();
    expect(await store.list('MMR')).toEqual([created]);

    const replacement: Scratchpad = {
      ...created,
      agenda: [{ content: 'Settle persistence', number: 1, reason: null, state: 'done' }],
      journal: [...created.journal, { at: UPDATED, content: 'Persistence settled.', number: 2 }],
      updatedAt: UPDATED,
    };
    await expectRejection(
      store.replace({ ...replacement, updatedAt: CREATED }, CREATED),
      /must advance/,
    );
    await expectRejection(
      store.replace({ ...replacement, updatedAt: '2026-08-03T11:59:00.000Z' }, CREATED),
      /must advance/,
    );
    await store.replace(replacement, CREATED);
    expect(await store.load(ID)).toEqual(replacement);

    await store.delete(ID, UPDATED);
    expect(await store.load(ID)).toBeUndefined();

    const corrupt = scratchpad(CORRUPT_ID);
    await store.create(corrupt);
    const corruptPath = join(vaultRoot, 'scratch', `${CORRUPT_ID}.md`);
    const malformed = readFileSync(corruptPath, 'utf8').replace(
      '## Agenda',
      '## Agenda\n\n1. [ ] duplicate\n\n## Agenda',
    );
    writeFileSync(corruptPath, malformed);

    expect(await store.load(CORRUPT_ID)).toBeUndefined();
    expect(await store.list('MMR')).toEqual([]);
    await expectRejection(store.delete(CORRUPT_ID, CREATED), /quarantined scratchpad/);
    expect(readFileSync(corruptPath, 'utf8')).toBe(malformed);
  },
);
