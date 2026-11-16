import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { DeliveryFindingRecord } from '@mimir/contract';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, refusalOf, withoutStamp } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('delivery lists and run journals transfer ($name)', (backend) => {
  let source: Awaited<ReturnType<typeof backend.make>>;
  let document: Awaited<ReturnType<typeof source.store.export>>;
  let first: string;
  let second: string;
  let padId: string;

  beforeAll(async () => {
    source = await backend.make();
    const engine = new LocalEngine(source.store);
    await createProject(source.store, { key: 'XFR', name: 'Transfer' });
    await createProject(source.store, { key: 'OTH', name: 'Other' });
    const initiative = await createInitiative(source.store, { projectId: 'XFR', title: 'Plan' });
    const phase = (await createPhase(source.store, { parentId: initiative.id, title: 'Phase' })).id;
    await createTask(source.store, { parentId: phase, title: 'Task' });
    // Appended out of delivery order, to prove the export orders by delivery sequence.
    first = (await engine.deliveryCreate({ phase, title: 'First' })).id;
    second = (await engine.deliveryCreate({ phase, title: 'Second' })).id;
    await engine.deliveryLimitation({ id: second, text: 'on second' });
    await engine.deliveryLimitation({ id: first, text: 'one' });
    await engine.deliveryDecline({ finding: 'two', id: first, reason: 'later' });
    // The first delivery's journal is frozen; the second's stays live.
    const frozen = await engine.scratchCreate({ anchors: [first], project: 'XFR', title: 'J1' });
    await engine.scratchFreeze({
      expectedUpdatedAt: frozen.updatedAt,
      id: frozen.id,
      summary: 'journal',
    });
    padId = (await engine.scratchCreate({ anchors: [second], project: 'XFR', title: 'J2' })).id;
    document = await source.store.export();
  });

  afterAll(async () => {
    await source.close();
  });

  test('entries and journal deliveries export in order and round-trip', async () => {
    expect(document.schema_version).toBe(14);
    expect(document.delivery_findings.map((e) => [e.delivery, e.number, e.kind])).toEqual([
      [first, 1, 'limitation'],
      [first, 2, 'declined'],
      [second, 1, 'limitation'],
    ]);
    expect(document.artifacts[0]?.delivery).toBe(first);
    expect(document.scratchpads[0]?.delivery).toBe(second);
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      const engine = new LocalEngine(target.store);
      expect(
        (await engine.deliveryLimitation({ id: first, text: 'next' })).limitations.at(-1)?.number,
      ).toBe(3);
      expect((await engine.getDelivery({ id: second })).journal.scratchpad).toBe(padId);
    } finally {
      await target.close();
    }
  });

  test('a document of the previous version reads as having no entries and no journal delivery', async () => {
    const { delivery_findings: _findings, ...older } = structuredClone(document);
    const target = await backend.make();
    try {
      const artifacts = older.artifacts.map(({ delivery: _d, ...rest }) => rest);
      const scratchpads = older.scratchpads.map(({ delivery: _d, ...rest }) => rest);
      await target.store.import(
        { ...older, artifacts, schema_version: 12, scratchpads },
        {
          dryRun: false,
          mode: 'fresh',
        },
      );
      const exported = await target.store.export();
      expect(exported.delivery_findings).toEqual([]);
      expect(exported.artifacts[0]?.delivery).toBeNull();
      expect(exported.scratchpads[0]?.delivery).toBeNull();
    } finally {
      await target.close();
    }
  });

  test('a resume refuses a differing entry', async () => {
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      await target.store.import(document, { dryRun: false, mode: 'resume' });
      const changed = structuredClone(document);
      changed.delivery_findings = changed.delivery_findings.map((row) =>
        row.number === 1 && row.delivery === first ? { ...row, text: 'rewritten' } : row,
      );
      expect(
        await refusalOf(target.store.import(changed, { dryRun: false, mode: 'resume' })),
      ).toContain('differs from the transfer document');
    } finally {
      await target.close();
    }
  });

  test('a resume refuses a second live pad on a delivery the store already holds (finding 2)', async () => {
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      const pad = document.scratchpads[0];
      if (pad === undefined) {
        throw new Error('missing fixture');
      }
      const rival = { ...pad, id: '223e4567-e89b-42d3-a456-426614174000' };
      const before = withoutStamp(await target.store.export());
      const refusal = await refusalOf(
        target.store.import(
          { ...structuredClone(document), scratchpads: [rival] },
          { dryRun: false, mode: 'resume' },
        ),
      );
      expect(refusal).toContain('live scratchpad');
      expect(refusal).toContain(padId);
      expect(withoutStamp(await target.store.export())).toEqual(before);
    } finally {
      await target.close();
    }
  });

  test('each invalid entry or journal reference is refused alone and writes nothing', async () => {
    const limitation = document.delivery_findings.find((row) => row.kind === 'limitation');
    const declined = document.delivery_findings.find((row) => row.kind === 'declined');
    if (limitation === undefined || declined === undefined) {
      throw new Error('missing fixture entries');
    }
    const entryCases: [string, DeliveryFindingRecord[], string][] = [
      ['a missing delivery', [{ ...limitation, delivery: 'XFR-d99' }], 'names a missing delivery'],
      ['number below 1', [{ ...limitation, number: 0 }], 'delivery_findings'],
      ['a number used twice', [limitation, { ...limitation }], 'number is used twice'],
      ['blank text', [{ ...limitation, text: ' ' }], 'text is blank'],
      ['a kind outside the set', [{ ...limitation, kind: 'note' as never }], 'delivery_findings'],
      [
        'declined without a reason',
        [{ ...declined, reason: null }],
        'is declined without a reason',
      ],
      [
        'declined with a blank reason',
        [{ ...declined, reason: ' ' }],
        'is declined without a reason',
      ],
      ['a limitation with a reason', [{ ...limitation, reason: 'why' }], 'carries a reason'],
      ['created_at no instant', [{ ...limitation, created_at: 'banana' }], 'created_at is not'],
      [
        'created_at with an offset',
        [{ ...limitation, created_at: '2026-11-16T09:00:00.000+05:00' }],
        'created_at is not',
      ],
    ];
    const target = await backend.make();
    try {
      for (const [name, entries, message] of entryCases) {
        const refusal = await refusalOf(
          target.store.import(
            { ...structuredClone(document), delivery_findings: entries },
            { dryRun: false, mode: 'fresh' },
          ),
        );
        expect(refusal, name).toContain(message);
        expect((await target.store.export()).projects, name).toEqual([]);
      }
      const pad = document.scratchpads[0];
      const artifact = document.artifacts[0];
      if (pad === undefined || artifact === undefined) {
        throw new Error('missing fixtures');
      }
      const journalCases: [string, Partial<typeof document>, string][] = [
        [
          'a pad on a missing delivery',
          { scratchpads: [{ ...pad, delivery: 'XFR-d99' }] },
          'delivery XFR-d99 is missing',
        ],
        [
          'an artifact on a missing delivery',
          { artifacts: [{ ...artifact, delivery: 'XFR-d99' }] },
          'delivery XFR-d99 is missing',
        ],
        [
          'a pad on a delivery of another project',
          { scratchpads: [{ ...pad, project: 'OTH' }] },
          'is in project XFR, not OTH',
        ],
        [
          'an artifact on a delivery of another project',
          { artifacts: [{ ...artifact, key: 'OTH', links: [] }] },
          'is in project XFR, not OTH',
        ],
        [
          'two live pads on one delivery',
          {
            scratchpads: [pad, { ...pad, id: '223e4567-e89b-42d3-a456-426614174000' }],
          },
          'live scratchpads',
        ],
      ];
      for (const [name, overrides, message] of journalCases) {
        const refusal = await refusalOf(
          target.store.import(
            { ...structuredClone(document), ...overrides },
            { dryRun: false, mode: 'fresh' },
          ),
        );
        expect(refusal, name).toContain(message);
      }
      expect((await target.store.export()).projects).toEqual([]);
    } finally {
      await target.close();
    }
  });
});
