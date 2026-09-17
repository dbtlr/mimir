import { expect, test } from 'bun:test';

import { fakeIo } from '../cli/testing';
import { cmdDoctor } from './commands';
import type { DoctorBackend, DoctorFinding, DoctorRepairReport } from './contract';

/**
 * `cmdDoctor` against the backend-neutral contract (ADR 0030 Decision 6). These
 * cases name no backend at all: they pin the transport contract — the repair
 * capability gate, the exit-code mapping, and the empty-scope warning — over a
 * hand-built {@link DoctorBackend}. The Norn backend's own behavior is pinned
 * beside its implementation, under `./norn`.
 */

function finding(overrides: Partial<DoctorFinding> = {}): DoctorFinding {
  return {
    check: 'crlf',
    code: 'crlf-body',
    evidence: {},
    locator: 'MMR/MMR-1.md',
    message: 'body uses CRLF line endings',
    node: 'MMR-1',
    scopeKey: 'MMR',
    severity: 'error',
    stem: 'MMR-1',
    where: 'body',
    ...overrides,
  };
}

function report(overrides: Partial<DoctorRepairReport> = {}): DoctorRepairReport {
  return {
    details: [],
    failed: [],
    fixed: [],
    mode: 'apply',
    outcome: 'applied',
    planned: [],
    scope: null,
    skipped: [],
    summary: { failed: 0, fixed: 0, planned: 0, skipped: 0 },
    ...overrides,
  };
}

function backend(overrides: Partial<DoctorBackend> = {}): DoctorBackend {
  return {
    diagnose: () => Promise.resolve({ findings: [], scope: null }),
    facet: () => Promise.resolve({ dropped_total: 0, groups: [], scanned_at: 'now', scope: null }),
    ...overrides,
  };
}

// The read-only property, asserted from the transport's side: a backend built
// for `serve`/`mcp` carries no `repair`, so `--fix` cannot reach a mutation.
test('a backend without repair refuses --fix instead of silently doing nothing', async () => {
  const readOnly = backend();
  expect(readOnly.repair).toBeUndefined();

  let threw = false;
  try {
    await cmdDoctor(fakeIo(), readOnly, 'json', 'MMR', { dryRun: false, fix: true });
  } catch (error) {
    threw = true;
    expect((error as Error).message).toBe('doctor repair is unavailable in this context');
  }
  expect(threw).toBe(true);
});

test('a bare run renders the backend findings and stays non-gating', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    backend({ diagnose: () => Promise.resolve({ findings: [finding()], scope: null }) }),
    'records',
    undefined,
  );

  expect(code).toBe(0);
  expect(io.err.join('')).toContain('[err] MMR-1: body uses CRLF line endings (body)');
});

test('an empty scope warns on both the bare and the repair path', async () => {
  const emptyScope = { key: 'OTH', matched_documents: 0 };

  const bare = fakeIo();
  await cmdDoctor(
    bare,
    backend({ diagnose: () => Promise.resolve({ findings: [], scope: emptyScope }) }),
    'json',
    'OTH',
  );
  expect(bare.err.join('')).toContain("[warn] doctor scope 'OTH' matched 0 documents");

  const repaired = fakeIo();
  await cmdDoctor(
    repaired,
    backend({ repair: () => Promise.resolve(report({ scope: emptyScope })) }),
    'json',
    'OTH',
    { dryRun: false, fix: true },
  );
  expect(repaired.err.join('')).toContain("[warn] doctor scope 'OTH' matched 0 documents");
});

// `failed` is the single nonzero signal — a preview and a clean apply both exit
// 0, so a repair pass never gates on findings it deliberately skipped.
test.each([
  ['applied' as const, 0],
  ['preview' as const, 0],
  ['failed' as const, 1],
])('a %s repair report exits %i', async (outcome, expected) => {
  const code = await cmdDoctor(
    fakeIo(),
    backend({ repair: () => Promise.resolve(report({ outcome })) }),
    'json',
    'MMR',
    { dryRun: outcome === 'preview', fix: true },
  );
  expect(code).toBe(expected);
});

test('the repair report renders its skipped items and summary verbatim', async () => {
  const io = fakeIo();
  await cmdDoctor(
    io,
    backend({
      repair: () =>
        Promise.resolve(
          report({
            mode: 'dry-run',
            outcome: 'preview',
            planned: [{ issue: finding(), recipe: 'normalize-crlf' }],
            skipped: [
              { issue: finding({ code: 'missing-project' }), reason: 'semantic-reference' },
            ],
            summary: { failed: 0, fixed: 0, planned: 1, skipped: 1 },
          }),
        ),
    }),
    'records',
    'MMR',
    { dryRun: true, fix: true },
  );

  const out = io.out.join('\n');
  expect(out).toContain('[planned] crlf-body MMR-1: normalize-crlf');
  expect(out).toContain('[skipped] missing-project MMR-1: semantic-reference');
  expect(out).toContain('doctor repair preview: 1 planned, 0 fixed, 1 skipped, 0 failed');
});
