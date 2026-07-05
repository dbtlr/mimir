import { expect, test } from 'bun:test';

import { fakeIo } from '../cli/testing';
import { renderMigratedNodeBody, renderNodeBody } from '../core/history-codec';
import { cmdDoctor } from './commands';
import type { DoctorDeps } from './commands';

/** A doctor deps whose vault holds exactly these `{ stem, body }` documents. */
function vaultOf(docs: { stem: string; body: string }[]): DoctorDeps {
  return { readNodeDocs: () => Promise.resolve(docs) };
}

const CLEAN_HISTORY = renderMigratedNodeBody(
  'a task',
  [
    {
      at: '2026-07-03T10:00:00.000Z',
      from: 'todo',
      kind: 'lifecycle',
      reason: null,
      to: 'in_progress',
    },
  ],
  [],
);
const MALFORMED = `## History\n### 2026-07-03T10:00:00.000Z — frobnicate\ntodo → done\n## Annotations\n`;

test('no-op with a clean stdout line and exit 0 when no vault backend is active', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(io, { readNodeDocs: null }, 'table', undefined);
  expect(code).toBe(0);
  expect(io.out.join('')).toContain('vault backend not active');
  expect(io.err.join('')).toBe('');
});

test('reports no problems and exits 0 over a clean vault', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([
      { body: renderNodeBody('a task'), stem: 'MMR-1' },
      { body: CLEAN_HISTORY, stem: 'MMR-2' },
    ]),
    'table',
    undefined,
  );
  expect(code).toBe(0);
  expect(io.out.join('')).toContain('no problems found');
  expect(io.err.join('')).toBe('');
});

test('surfaces a malformed record as a stderr alert and exits 1', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: MALFORMED, stem: 'MMR-9' }]),
    'table',
    undefined,
  );
  expect(code).toBe(1);
  expect(io.out.join('')).toBe(''); // findings are the loud channel: stderr only
  const err = io.err.join('');
  expect(err).toContain('MMR-9');
  expect(err).toContain('unknown transition kind');
  expect(err).toContain('History · line 2');
});

test('json format emits the findings array on stdout and still exits 1', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: MALFORMED, stem: 'MMR-9' }]),
    'json',
    undefined,
  );
  expect(code).toBe(1);
  const findings = JSON.parse(io.out.join('')) as { node: string; check: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ check: 'body-sections', node: 'MMR-9', severity: 'error' });
});

test('json no-op emits an empty array and exits 0', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(io, { readNodeDocs: null }, 'json', undefined);
  expect(code).toBe(0);
  expect(io.out.join('')).toBe('[]');
});

test('the -s scope keeps the project and its nodes, dropping other projects', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([
      { body: MALFORMED, stem: 'MMR-9' }, // in scope
      { body: MALFORMED, stem: 'MMR' }, // the project itself — in scope
      { body: MALFORMED, stem: 'OTH-3' }, // other project — filtered out
    ]),
    'json',
    'MMR',
  );
  expect(code).toBe(1);
  const findings = JSON.parse(io.out.join('')) as { node: string }[];
  expect(findings.map((f) => f.node).toSorted()).toEqual(['MMR', 'MMR-9']);
});
