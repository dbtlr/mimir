import { expect, test } from 'bun:test';

import { Application, Command } from '@loomcli/core';
import { format } from '@loomcli/plugins/format';

import { runArgv } from '../testing/run';
import { recordViews } from './views';
import type { RecordViewSpec } from './views';

type Shown = { doc: unknown; rows: unknown[] };

/** A probe whose one command prints `shown` through the views `spec` declares. */
function probe(shown: Shown, spec: Omit<RecordViewSpec<Shown>, 'records'>) {
  const views = recordViews<Shown>({ ...spec, records: () => 'records' });
  return new Application('probe', {
    description: 'A probe.',
    plugins: [format({ short: 'f' })],
  }).command(
    new Command('show', { description: 'Show one value.' })
      .result<Shown>({ views })
      .action(async ({ out }) => {
        await out.results(shown);
      }),
  );
}

async function printed(app: ReturnType<typeof probe>, view: 'json' | 'jsonl'): Promise<string> {
  return (await runArgv(app, ['show', '-f', view])).stdout;
}

const doc = { id: 'MMR-1', tags: ['a'] };

test('json is the indented document, and jsonl repeats it under its own media type', async () => {
  const app = probe({ doc, rows: [] }, { json: (shown) => shown.doc });
  const indented = `${JSON.stringify(doc, null, 2)}\n`;
  expect(await printed(app, 'json')).toBe(indented);
  expect(await printed(app, 'jsonl')).toBe(indented);
  const views = recordViews<Shown>({ json: (shown) => shown.doc, records: () => '' });
  expect([views.json.mediaType, views.jsonl.mediaType]).toEqual([
    'application/json',
    'application/jsonl',
  ]);
});

test('a compact document prints on one line under both formats, an array document too', async () => {
  const app = probe({ doc, rows: [] }, { compact: true, json: (shown) => shown.doc });
  expect(await printed(app, 'json')).toBe(`${JSON.stringify(doc)}\n`);
  expect(await printed(app, 'jsonl')).toBe(`${JSON.stringify(doc)}\n`);
  const array = probe({ doc: [1, 2], rows: [] }, { compact: true, json: (shown) => shown.doc });
  expect(await printed(array, 'json')).toBe('[1,2]\n');
  expect(await printed(array, 'jsonl')).toBe('[1,2]\n');
  const views = recordViews<Shown>({
    compact: true,
    json: (shown) => shown.doc,
    records: () => '',
  });
  expect([views.json.mediaType, views.jsonl.mediaType]).toEqual([
    'application/json',
    'application/jsonl',
  ]);
});

test("jsonl 'compact' prints the indented json document on one line", async () => {
  const app = probe({ doc, rows: [] }, { json: (shown) => shown.doc, jsonl: 'compact' });
  expect(await printed(app, 'json')).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  expect(await printed(app, 'jsonl')).toBe(`${JSON.stringify(doc)}\n`);
});

test('jsonl rows print one line each, and an empty list one empty line', async () => {
  const spec = {
    json: (shown: Readonly<Shown>) => shown.doc,
    jsonl: (shown: Readonly<Shown>) => shown.rows,
  };
  expect(await printed(probe({ doc, rows: [{ n: 1 }, { n: 2 }] }, spec), 'jsonl')).toBe(
    '{"n":1}\n{"n":2}\n',
  );
  expect(await printed(probe({ doc, rows: [] }, spec), 'jsonl')).toBe('\n');
});

test('DEL and the C1 controls in the data print escaped, so none reaches a terminal', async () => {
  const shown = { doc: { title: 'a\u007Fb\u009Bc' }, rows: [{ title: '\u0085' }] };
  const app = probe(shown, { json: (s) => s.doc, jsonl: (s) => s.rows });
  expect(await printed(app, 'json')).toBe('{\n  "title": "a\\u007fb\\u009bc"\n}\n');
  expect(await printed(app, 'jsonl')).toBe('{"title":"\\u0085"}\n');
});
