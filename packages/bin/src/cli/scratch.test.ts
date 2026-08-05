import { expect, test } from 'bun:test';
import { join } from 'node:path';

import type { Scratchpad } from '@mimir/contract';

import type { Store } from '../core';
import { createProject } from '../core';
import type { ArtifactStore } from '../core/artifacts/store';
import type { ScratchpadStore } from '../core/scratchpads/store';
import { createTestStore } from '../testing/store';
import { runCli } from './run';
import { fakeIo } from './testing';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const MEMORY_PROJECTS = [
  {
    archived_at: null,
    created_at: '2026-08-03T00:00:00.000Z',
    description: null,
    key: 'MMR',
    name: 'Mimir',
    updated_at: '2026-08-03T00:00:00.000Z',
  },
];

const loadMemoryProjects = () => Promise.resolve(MEMORY_PROJECTS);

const unopenedStore = (): never => {
  throw new Error('invalid usage must not open the store');
};

const jsonOutput = (io: ReturnType<typeof fakeIo>): Record<string, unknown> =>
  JSON.parse(io.out.at(-1) ?? '{}') as Record<string, unknown>;

function freshCli(vaultRoot: string, args: string[]): { code: number; err: string; out: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, '..', 'main.ts'), ...args],
    env: { ...process.env, MIMIR_VAULT: vaultRoot },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    code: result.exitCode,
    err: result.stderr.toString(),
    out: result.stdout.toString(),
  };
}
const NORN = Bun.which('norn') !== null;

function memoryStore() {
  const pads = new Map<string, Scratchpad>();
  const scratchpads: ScratchpadStore = {
    async create(pad) {
      pads.set(pad.id, pad);
    },
    async delete(id) {
      pads.delete(id);
    },
    async list(project) {
      return [...pads.values()].filter((pad) => project === undefined || pad.project === project);
    },
    async load(id) {
      return pads.get(id);
    },
    async replace(pad) {
      pads.set(pad.id, pad);
    },
  };
  const artifacts = {
    async create(input: { key: string; title: string; summary?: string | null }) {
      return {
        content: '',
        created_at: '2026-08-03T00:00:00.000Z',
        key: input.key,
        links: [],
        seq: 1,
        summary: input.summary ?? null,
        tags: ['scratchpad'],
        title: input.title,
        updated_at: '2026-08-03T00:00:00.000Z',
      };
    },
    async findBySourceScratch() {
      return undefined;
    },
  } as unknown as ArtifactStore;
  return {
    pads,
    store: { artifacts, loadProjects: loadMemoryProjects, scratchpads } as unknown as Store,
  };
}

test('scratch create uses binding and returns a compact concurrency receipt', async () => {
  const { store } = memoryStore();
  const io = fakeIo();
  expect(
    await runCli(
      [
        'scratch',
        'create',
        'CLI',
        'contract',
        '--link',
        'MMR-331',
        '--link',
        'MMR-332',
        '-f',
        'json',
      ],
      () => store,
      io,
      { scope: 'MMR' },
    ),
  ).toBe(0);
  const result = JSON.parse(io.out[0] ?? '{}') as Record<string, unknown>;
  expect(result.project).toBe('MMR');
  expect(result.open_agenda).toBe(0);
  expect(result.updated_at).toBeString();
  expect(result).not.toHaveProperty('journal');
  expect(result.title).toBe('CLI contract');
});

test('invalid scratch noun-group tokens do not open the store', async () => {
  expect(await runCli(['scratch'], unopenedStore, fakeIo())).toBe(2);
  expect(await runCli(['scratch', 'wat'], unopenedStore, fakeIo())).toBe(2);
  expect(await runCli(['scratch', 'agenda', 'wat'], unopenedStore, fakeIo())).toBe(2);
});

test('Scratchpad-only flags are rejected by unrelated verbs before opening the store', async () => {
  for (const args of [
    ['list', '--clear-links'],
    ['list', '--expected-updated-at', 'stamp'],
    ['list', '--force'],
    ['list', '--reason', 'because'],
  ]) {
    expect(await runCli(args, unopenedStore, fakeIo())).toBe(2);
  }
});

test('scratch UUID mutations require and advance the explicit guard', async () => {
  const { pads, store } = memoryStore();
  pads.set(ID, {
    agenda: [],
    anchors: [],
    createdAt: '2026-08-03T00:00:00.000Z',
    freezingAt: null,
    id: ID,
    journal: [],
    project: 'MMR',
    title: 'CLI',
    updatedAt: '2026-08-03T00:00:00.000Z',
  });
  const missing = fakeIo();
  expect(await runCli(['scratch', 'checkpoint', ID, 'note'], () => store, missing)).toBe(2);
  expect(missing.err.join('')).toContain('--expected-updated-at');

  const io = fakeIo();
  expect(
    await runCli(
      [
        'scratch',
        'checkpoint',
        ID,
        'note',
        '--expected-updated-at',
        '2026-08-03T00:00:00.000Z',
        '-f',
        'json',
      ],
      () => store,
      io,
    ),
  ).toBe(0);
  const result = JSON.parse(io.out[0] ?? '{}') as Record<string, unknown>;
  expect(result.updated_at).not.toBe('2026-08-03T00:00:00.000Z');
  expect(pads.get(ID)?.journal[0]?.content).toBe('note');
});

// MMR-350 (ADR 0029): the human formats render instants in the reader's zone;
// the wire object `-f json` emits is untouched canonical UTC.
test('scratch get renders local instants on records and canonical UTC on json', async () => {
  const { pads, store } = memoryStore();
  pads.set(ID, {
    agenda: [],
    anchors: [],
    createdAt: '2026-08-05T13:14:00.000Z',
    freezingAt: null,
    id: ID,
    journal: [{ at: '2026-08-05T13:20:00.000Z', content: 'note', number: 1 }],
    project: 'MMR',
    title: 'CLI',
    updatedAt: '2026-08-05T13:20:00.000Z',
  });

  const human = fakeIo();
  expect(await runCli(['scratch', 'get', ID, '-f', 'records'], () => store, human)).toBe(0);
  const text = human.out.join('\n');
  expect(text).toContain('created at  2026-08-05 09:14 EDT');
  expect(text).toContain('updated at  2026-08-05 09:20 EDT');
  expect(text).toContain('2026-08-05 09:20 EDT'); // the Journal entry's own stamp
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);

  const machine = fakeIo();
  expect(await runCli(['scratch', 'get', ID, '-f', 'json'], () => store, machine)).toBe(0);
  const wire = JSON.parse(machine.out[0] ?? '{}') as Record<string, unknown>;
  expect(wire.created_at).toBe('2026-08-05T13:14:00.000Z');
  expect(wire.updated_at).toBe('2026-08-05T13:20:00.000Z');
  expect(JSON.stringify(wire.journal)).toContain('2026-08-05T13:20:00.000Z');
});

test('scratch update distinguishes omitted, repeated, and explicitly cleared links', async () => {
  const { pads, store } = memoryStore();
  pads.set(ID, {
    agenda: [],
    anchors: ['MMR-1'],
    createdAt: '2026-08-03T00:00:00.000Z',
    freezingAt: null,
    id: ID,
    journal: [],
    project: 'MMR',
    title: 'CLI',
    updatedAt: '2026-08-03T00:00:00.000Z',
  });
  const omitted = fakeIo();
  expect(
    await runCli(
      [
        'scratch',
        'update',
        ID,
        '--title',
        'Renamed',
        '--expected-updated-at',
        '2026-08-03T00:00:00.000Z',
      ],
      () => store,
      omitted,
    ),
  ).toBe(0);
  expect(pads.get(ID)?.anchors).toEqual(['MMR-1']);
  expect(pads.get(ID)?.title).toBe('Renamed');
  const initialStamp = pads.get(ID)?.updatedAt ?? '';
  const first = fakeIo();
  expect(
    await runCli(
      [
        'scratch',
        'update',
        ID,
        '--link',
        'MMR-2',
        '--link',
        'MMR-3',
        '--expected-updated-at',
        initialStamp,
        '-f',
        'json',
      ],
      () => store,
      first,
    ),
  ).toBe(0);
  expect(pads.get(ID)?.anchors).toEqual(['MMR-2', 'MMR-3']);
  const stamp = pads.get(ID)?.updatedAt ?? '';
  expect(
    await runCli(
      ['scratch', 'update', ID, '--clear-links', '--expected-updated-at', stamp],
      () => store,
      fakeIo(),
    ),
  ).toBe(0);
  expect(pads.get(ID)?.anchors).toEqual([]);
});

test('scratch list marks staged freezes in the human view', async () => {
  const { pads, store } = memoryStore();
  pads.set(ID, {
    agenda: [],
    anchors: [],
    createdAt: '2026-08-03T00:00:00.000Z',
    freezingAt: '2026-08-03T00:00:01.000Z',
    id: ID,
    journal: [],
    project: 'MMR',
    title: 'Recover me',
    updatedAt: '2026-08-03T00:00:01.000Z',
  });
  const io = fakeIo(true);
  expect(await runCli(['scratch', 'list'], () => store, io, { scope: 'MMR' })).toBe(0);
  expect(io.out.join('\n')).toContain(`freezing  ${ID}`);
});

test('nested Scratchpad help resolves the exact Agenda operation without opening the store', async () => {
  const io = fakeIo(true);
  expect(
    await runCli(
      ['scratch', 'agenda', 'supersede', '--help'],
      () => {
        throw new Error('help must not open the store');
      },
      io,
    ),
  ).toBe(0);
  expect(io.out.join('\n')).toContain(
    'mimir scratch agenda supersede <uuid> <number> --reason <text>',
  );
});

test.skipIf(!NORN)(
  'isolated-vault CLI lifecycle supports resume, guards, freeze recovery, and discard refusal',
  async () => {
    const fixture = await createTestStore();
    try {
      await createProject(fixture.store, { key: 'MMR', name: 'Mimir' });
      const invoke = async (args: string[]) => {
        const io = fakeIo();
        const code = await runCli(args, () => fixture.store, io, { scope: 'MMR' });
        return { code, io };
      };
      const created = await invoke(['scratch', 'create', 'Norn lifecycle', '-f', 'json']);
      expect(created.code).toBe(0);
      const createReceipt = jsonOutput(created.io);
      const id = String(createReceipt.id);
      let stamp = String(createReceipt.updated_at);

      const checkpoint = await invoke([
        'scratch',
        'checkpoint',
        id,
        'first durable checkpoint',
        '--expected-updated-at',
        stamp,
        '-f',
        'json',
      ]);
      expect(checkpoint.code).toBe(0);
      stamp = String(jsonOutput(checkpoint.io).updated_at);

      const overviewIo = fakeIo(true);
      expect(await runCli(['overview'], () => fixture.store, overviewIo, { scope: 'MMR' })).toBe(0);
      expect(overviewIo.out.join('\n')).toContain('active scratchpads (1)');
      expect(overviewIo.out.join('\n')).toContain(`${id} · MMR · Norn lifecycle · 0 open Agenda`);

      const addOne = await invoke([
        'scratch',
        'agenda',
        'add',
        id,
        'ship the CLI',
        '--expected-updated-at',
        stamp,
        '-f',
        'json',
      ]);
      expect(addOne.code).toBe(0);
      stamp = String(jsonOutput(addOne.io).updated_at);
      const completeOne = await invoke([
        'scratch',
        'agenda',
        'complete',
        id,
        '1',
        '--expected-updated-at',
        stamp,
        '-f',
        'json',
      ]);
      expect(completeOne.code).toBe(0);
      stamp = String(jsonOutput(completeOne.io).updated_at);
      const addTwo = await invoke([
        'scratch',
        'agenda',
        'add',
        id,
        'obsolete follow-up',
        '--expected-updated-at',
        stamp,
        '-f',
        'json',
      ]);
      expect(addTwo.code).toBe(0);
      stamp = String(jsonOutput(addTwo.io).updated_at);
      const supersedeTwo = await invoke([
        'scratch',
        'agenda',
        'supersede',
        id,
        '2',
        '--reason',
        'covered elsewhere',
        '--expected-updated-at',
        stamp,
        '-f',
        'json',
      ]);
      expect(supersedeTwo.code).toBe(0);
      stamp = String(jsonOutput(supersedeTwo.io).updated_at);

      // Separate Mimir processes reconstruct the store over this isolated vault,
      // discover the UUID, and resume the complete document.
      const listed = freshCli(fixture.vaultRoot, ['scratch', 'list', '-s', 'MMR', '-f', 'ids']);
      expect(listed.code, listed.err).toBe(0);
      expect(listed.out).toContain(id);
      const resumed = freshCli(fixture.vaultRoot, ['scratch', 'get', id, '-f', 'json']);
      expect(resumed.code, resumed.err).toBe(0);
      const full = JSON.parse(resumed.out) as Record<string, unknown>;
      expect(full.journal).toEqual([
        expect.objectContaining({ content: 'first durable checkpoint', number: 1 }),
      ]);
      expect(full.agenda).toEqual([
        expect.objectContaining({ number: 1, state: 'done' }),
        expect.objectContaining({ number: 2, reason: 'covered elsewhere', state: 'superseded' }),
      ]);

      const stale = await invoke([
        'scratch',
        'update',
        id,
        '--title',
        'must refuse',
        '--expected-updated-at',
        String(createReceipt.updated_at),
      ]);
      expect(stale.code).toBe(1);
      expect(stale.io.err.join('\n')).toContain('changed concurrently');

      const frozen = await invoke([
        'scratch',
        'freeze',
        id,
        '--summary',
        'Lifecycle proof',
        '--expected-updated-at',
        stamp,
        '-f',
        'json',
      ]);
      expect(frozen.code).toBe(0);
      expect(jsonOutput(frozen.io).id).toBe('MMR-a1');
      const recovered = await invoke([
        'scratch',
        'freeze',
        id,
        '--summary',
        'Lifecycle proof',
        '--expected-updated-at',
        stamp,
        '-f',
        'json',
      ]);
      expect(recovered.code).toBe(0);
      expect(jsonOutput(recovered.io).id).toBe('MMR-a1');

      const disposable = await invoke(['scratch', 'create', 'Discard path', '-f', 'json']);
      expect(disposable.code).toBe(0);
      const discardId = String(jsonOutput(disposable.io).id);
      let discardStamp = String(jsonOutput(disposable.io).updated_at);
      const open = await invoke([
        'scratch',
        'agenda',
        'add',
        discardId,
        'still open',
        '--expected-updated-at',
        discardStamp,
        '-f',
        'json',
      ]);
      discardStamp = String(jsonOutput(open.io).updated_at);
      const refused = await invoke([
        'scratch',
        'discard',
        discardId,
        '--expected-updated-at',
        discardStamp,
      ]);
      expect(refused.code).toBe(1);
      expect(refused.io.err.join('\n')).toContain('open Agenda items');
      const forced = await invoke([
        'scratch',
        'discard',
        discardId,
        '--force',
        '--reason',
        'test cleanup',
        '--expected-updated-at',
        discardStamp,
        '-f',
        'json',
      ]);
      expect(forced.code).toBe(0);
      expect(jsonOutput(forced.io).result).toBe('discarded');
      expect(await fixture.store.scratchpads.load(discardId)).toBeUndefined();
    } finally {
      await fixture.close();
    }
  },
);
