import { beforeAll, describe, expect, test } from 'bun:test';

import { createProject } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, refusalOf, withoutStamp } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('option details ($name)', (backend) => {
  test('aligned details survive reads and transfer; absent and all-null inputs store null', async () => {
    const source = await backend.make();
    const target = await backend.make();
    try {
      await createProject(source.store, { key: 'DEC', name: 'Decisions' });
      const engine = new LocalEngine(source.store);
      const input = {
        class: 'other' as const,
        options: ['A', 'B'],
        project: 'DEC',
        question: 'Which?',
        recommended: 1,
      };
      for (const option_details of [[null, 'Context\nMore'], [null, null], undefined]) {
        const d = await engine.decide({ ...input, option_details });
        expect(d.option_details).toEqual(option_details ?? [null, null]);
        expect((await engine.getDecision({ id: d.id })).option_details).toEqual(d.option_details);
      }
      expect((await engine.decisions({ project: 'DEC' })).map((d) => d.option_details)).toEqual([
        [null, 'Context\nMore'],
        [null, null],
        [null, null],
      ]);
      const document = await source.store.export();
      expect(document.decisions.map((d) => d.option_details)).toEqual([
        [null, 'Context\nMore'],
        null,
        null,
      ]);
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      for (const option_details of [[], ['Context'], [null, ' ']]) {
        expect(await refusalOf(engine.decide({ ...input, option_details }))).toContain(
          'option_details',
        );
      }
    } finally {
      await source.close();
      await target.close();
    }
  });

  test('missing details import at old and current versions; invalid stored forms refuse import', async () => {
    const source = await backend.make();
    try {
      await createProject(source.store, { key: 'DEC', name: 'Decisions' });
      await new LocalEngine(source.store).decide({
        class: 'other',
        options: ['A', 'B'],
        project: 'DEC',
        question: 'Which?',
        recommended: 1,
      });
      const document = await source.store.export();
      const original = document.decisions[0];
      if (!original) {
        throw new Error('missing decision');
      }
      const { option_details: _details, ...legacy } = original;
      for (const schema_version of [14, document.schema_version]) {
        const target = await backend.make();
        try {
          await target.store.import(
            { ...document, decisions: [legacy], schema_version },
            { dryRun: false, mode: 'fresh' },
          );
          expect(
            (await new LocalEngine(target.store).getDecision({ id: original.id })).option_details,
          ).toEqual([null, null]);
        } finally {
          await target.close();
        }
      }
      const target = await backend.make();
      try {
        for (const option_details of ['bad', [], ['text'], [null, 2], [null, ' '], [null, null]]) {
          expect(
            await refusalOf(
              target.store.import(
                {
                  ...document,
                  decisions: [{ ...original, option_details }],
                },
                { dryRun: false, mode: 'fresh' },
              ),
            ),
          ).toContain('option_details');
          expect((await target.store.export()).projects).toEqual([]);
        }
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  });
});
