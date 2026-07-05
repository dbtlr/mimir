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

// An unknown transition kind: the reader reads it as text (not a transition), so
// it is a `warn` — surfaced, but it does not gate.
const WARN_DOC = `## History\n### 2026-07-03T10:00:00.000Z — frobnicate\nactive → done\n## Annotations\n`;

// A valid record heading with no edge line: the reader DROPS the record, losing
// the transition — a genuine `error` that gates (nonzero exit).
const ERROR_DOC = `## History\n### 2026-07-03T10:00:00.000Z — lifecycle\n## Annotations\n`;

// A hand edit leaving an unescaped `### ` line inside a valid record's reason:
// the MMR-161 reader keeps it as reason content (lossless), so doctor must NOT
// error on it — it is a `warn` at most.
const TOLERATED_HASH_DOC = `## History\n### 2026-07-03T10:00:00.000Z — lifecycle\nactive → done\n### a hand note\n## Annotations\n`;

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

test('a dropped record (missing edge) is an error alert on stderr and exits 1', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: ERROR_DOC, stem: 'MMR-9' }]),
    'table',
    undefined,
  );
  expect(code).toBe(1);
  expect(io.out.join('')).toBe(''); // errors are the loud channel: stderr only
  const err = io.err.join('');
  expect(err).toContain('[error]');
  expect(err).toContain('MMR-9');
  expect(err).toContain('dropped on read');
  expect(err).toContain('History · line 2');
});

test('an unknown kind is a non-gating warn (exit 0), not an error', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: WARN_DOC, stem: 'MMR-9' }]),
    'table',
    undefined,
  );
  expect(code).toBe(0); // a warn never gates a cutover
  expect(io.err.join('')).toContain('[warn]');
  expect(io.err.join('')).toContain('unknown transition kind');
});

test('an unescaped heading inside a valid reason is a warn, not an error (MMR-161 tolerance)', async () => {
  // The reader absorbs `### a hand note` as reason content losslessly, so doctor
  // must not error or gate on it — regression against flagging tolerated content.
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: TOLERATED_HASH_DOC, stem: 'MMR-9' }]),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { severity: string; where: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]?.severity).toBe('warn');
});

test('json format emits a pretty findings array on stdout and exits 1 on an error', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: ERROR_DOC, stem: 'MMR-9' }]),
    'json',
    undefined,
  );
  expect(code).toBe(1);
  const out = io.out.join('');
  expect(out).toContain('\n  '); // 2-space pretty-printed, not compact
  const findings = JSON.parse(out) as { node: string; check: string; severity: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ check: 'body-sections', node: 'MMR-9', severity: 'error' });
});

test('jsonl format emits one finding per line (NDJSON), not a single array', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([
      { body: ERROR_DOC, stem: 'MMR-9' },
      { body: WARN_DOC, stem: 'MMR-8' },
    ]),
    'jsonl',
    undefined,
  );
  expect(code).toBe(1); // one of the two is an error
  const lines = io.out.join('').split('\n');
  expect(lines).toHaveLength(2);
  const parsed = lines.map((l) => JSON.parse(l) as { node: string });
  expect(parsed.map((p) => p.node).toSorted()).toEqual(['MMR-8', 'MMR-9']);
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
      { body: ERROR_DOC, stem: 'MMR-9' }, // in scope
      { body: ERROR_DOC, stem: 'MMR' }, // the project itself — in scope
      { body: ERROR_DOC, stem: 'OTH-3' }, // other project — filtered out
    ]),
    'json',
    'MMR',
  );
  expect(code).toBe(1);
  const findings = JSON.parse(io.out.join('')) as { node: string }[];
  expect(findings.map((f) => f.node).toSorted()).toEqual(['MMR', 'MMR-9']);
});
