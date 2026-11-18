import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { ChecklistRecord } from '@mimir/contract';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, refusalOf, withoutStamp } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('checklist transfer ($name)', (backend) => {
  // One source holds the records every case reads; each case imports into its own target.
  let source: Awaited<ReturnType<typeof backend.make>>;
  let document: Awaited<ReturnType<typeof source.store.export>>;
  let phase: string;
  let first: string;
  let second: string;

  beforeAll(async () => {
    source = await backend.make();
    const engine = new LocalEngine(source.store);
    await createProject(source.store, { key: 'CHK', name: 'Checklists' });
    const initiative = await createInitiative(source.store, { projectId: 'CHK', title: 'Plan' });
    phase = (await createPhase(source.store, { parentId: initiative.id, title: 'Phase' })).id;
    first = (await createTask(source.store, { parentId: phase, title: 'First' })).id;
    second = (await createTask(source.store, { parentId: phase, title: 'Second' })).id;
    // Added out of task order, to prove the export orders by task sequence.
    await engine.itemAdd({ content: 'on second', task: second });
    await engine.itemAdd({ content: 'one', task: first });
    await engine.itemAdd({ content: 'two', task: first });
    await engine.itemAdd({ content: 'three', task: first });
    await engine.itemCheck({ number: 1, task: first });
    await engine.itemDrop({ number: 2, reason: 'Covered elsewhere', task: first });
    document = await source.store.export();
  });

  afterAll(async () => {
    await source.close();
  });

  test('items export in task-sequence then number order and round-trip', async () => {
    expect(document.schema_version).toBe(15);
    expect(document.checklist_items.map((item) => [item.task, item.number, item.state])).toEqual([
      [first, 1, 'checked'],
      [first, 2, 'dropped'],
      [first, 3, 'open'],
      [second, 1, 'open'],
    ]);
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      const engine = new LocalEngine(target.store);
      expect((await engine.itemAdd({ content: 'next', task: first })).items.at(-1)?.number).toBe(4);
    } finally {
      await target.close();
    }
  });

  test('a document of the previous version reads as having no items', async () => {
    const { checklist_items: _items, ...older } = structuredClone(document);
    const target = await backend.make();
    try {
      await target.store.import({ ...older, schema_version: 11 }, { dryRun: false, mode: 'fresh' });
      expect((await target.store.export()).checklist_items).toEqual([]);
    } finally {
      await target.close();
    }
  });

  test('a resume skips items it already holds and refuses a differing item', async () => {
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      await target.store.import(document, { dryRun: false, mode: 'resume' });
      const changed = structuredClone(document);
      const item = changed.checklist_items.find((row) => row.task === first && row.number === 3);
      if (item === undefined) {
        throw new Error('missing item');
      }
      const edited = changed.checklist_items.map((row) =>
        row === item ? { ...row, content: 'rewritten' } : row,
      );
      expect(
        await refusalOf(
          target.store.import(
            { ...changed, checklist_items: edited },
            { dryRun: false, mode: 'resume' },
          ),
        ),
      ).toContain('differs from the transfer document');
    } finally {
      await target.close();
    }
  });

  test('each invalid item is refused alone and writes nothing', async () => {
    const [open, dropped] = [
      document.checklist_items.find((row) => row.state === 'open'),
      document.checklist_items.find((row) => row.state === 'dropped'),
    ];
    const checked = document.checklist_items.find((row) => row.state === 'checked');
    if (open === undefined || dropped === undefined || checked === undefined) {
      throw new Error('missing fixture items');
    }
    const cases: [string, ChecklistRecord[], string][] = [
      ['a missing task', [{ ...open, task: 'CHK-99' }], 'names a missing task'],
      ['a phase', [{ ...open, task: phase }], 'names a phase, not a task'],
      ['number below 1', [{ ...open, number: 0 }], 'checklist_items'],
      ['a number used twice', [open, { ...open }], 'number is used twice on its task'],
      ['blank content', [{ ...open, content: ' ' }], 'content is blank'],
      ['a state outside the set', [{ ...open, state: 'done' as never }], 'checklist_items'],
      ['dropped without a reason', [{ ...dropped, reason: null }], 'is dropped without a reason'],
      ['dropped with a blank reason', [{ ...dropped, reason: ' ' }], 'is dropped without a reason'],
      ['open with a reason', [{ ...open, reason: 'why' }], 'is open but carries a reason'],
      ['checked with a reason', [{ ...checked, reason: 'why' }], 'is checked but carries a reason'],
      [
        'open with a settled_at',
        [{ ...open, settled_at: open.created_at }],
        'is open but has a settled_at',
      ],
      [
        'checked without a settled_at',
        [{ ...checked, settled_at: null }],
        'is checked without a settled_at',
      ],
      [
        'settled before created',
        [{ ...checked, settled_at: '2000-01-01T00:00:00.000Z' }],
        'settled_at is before its created_at',
      ],
      ['created_at that is no instant', [{ ...open, created_at: 'banana' }], 'created_at is not'],
      [
        'created_at with an offset',
        [{ ...open, created_at: '2026-11-16T09:00:00.000+05:00' }],
        'created_at is not',
      ],
      [
        'settled_at that is no instant',
        [{ ...checked, settled_at: 'banana' }],
        'settled_at is not',
      ],
      [
        'settled_at with an offset',
        [
          {
            ...checked,
            created_at: '2026-11-16T09:00:00.000Z',
            settled_at: '2026-11-16T10:00:00.000+05:00',
          },
        ],
        'settled_at is not',
      ],
    ];
    // A refused import writes nothing, so one target serves every case.
    const target = await backend.make();
    try {
      for (const [name, items, message] of cases) {
        const refusal = await refusalOf(
          target.store.import(
            { ...structuredClone(document), checklist_items: items },
            { dryRun: false, mode: 'fresh' },
          ),
        );
        expect(refusal, name).toContain(message);
        expect((await target.store.export()).projects, name).toEqual([]);
      }
    } finally {
      await target.close();
    }
  });
});
