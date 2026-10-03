import { expect, test } from 'bun:test';

import { fakeIo } from '../cli/testing';
import { cmdDoctor } from './commands';
import type { DoctorBackend, DoctorFinding } from './contract';

/**
 * `cmdDoctor` against the backend-neutral contract (ADR 0030 Decision 6). These
 * cases name no backend at all: they pin the transport contract — the
 * exit-code mapping and the empty-scope warning — over a hand-built
 * {@link DoctorBackend}. The SQL doctor's own behavior is pinned beside its
 * implementation, under `./sql`.
 */

function finding(overrides: Partial<DoctorFinding> = {}): DoctorFinding {
  return {
    check: 'dangling-parent',
    code: 'dangling-parent',
    evidence: { parent_id: 'MMR-404', value: 'MMR-404' },
    locator: 'node/MMR-1',
    message: 'MMR-1 names parent MMR-404, which no node row holds',
    node: 'MMR-1',
    scopeKey: 'MMR',
    severity: 'error',
    stem: 'MMR-1',
    where: 'node · parent_id',
    ...overrides,
  };
}

function backend(overrides: Partial<DoctorBackend> = {}): DoctorBackend {
  return {
    diagnose: () => Promise.resolve({ findings: [], scope: null }),
    facet: () => Promise.resolve({ finding_total: 0, groups: [], scanned_at: 'now', scope: null }),
    ...overrides,
  };
}

test('a bare run renders the backend findings and stays non-gating', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    backend({ diagnose: () => Promise.resolve({ findings: [finding()], scope: null }) }),
    'records',
    undefined,
  );

  expect(code).toBe(0);
  expect(io.err.join('')).toContain(
    '[err] MMR-1: MMR-1 names parent MMR-404, which no node row holds (node · parent_id)',
  );
});

test('an empty scope warns rather than reading as a clean scan', async () => {
  const io = fakeIo();
  await cmdDoctor(
    io,
    backend({
      diagnose: () => Promise.resolve({ findings: [], scope: { key: 'OTH', matched_records: 0 } }),
    }),
    'json',
    'OTH',
  );
  expect(io.err.join('')).toContain("[warn] doctor scope 'OTH' matched 0 records");
});
