import { expect, test } from 'bun:test';

import type { Drop } from '../core/validate';
import type { DoctorContext } from './checks';
import { seedValidityCheck, upstreamRefCheck } from './checks';

/**
 * MMR-245 (annotation #2): with the resolving read seam real, the seed/upstream
 * severities must be truthful — `error` means "the reader drops/nulls it",
 * `warn` means "surfaced for repair, the reader tolerates it".
 */
const ctx = (drop: Drop): DoctorContext => ({
  dropped: [drop],
  projectRefs: [],
  readNodeDocs: () => Promise.resolve([]),
  sectionFailures: [],
  validateFindings: [],
});

test('dangling-spawned is error — the verb read prunes the ref', async () => {
  const [f] = await seedValidityCheck.run(
    ctx({ kind: 'edge', ref: 'MMR-9', rule: 'dangling-spawned', stem: 'MMR-s1' }),
  );
  expect(f?.severity).toBe('error');
  expect(f?.message).toMatch(/pruned on read/);
});

test('unknown-requester is error — the verb read nulls the field', async () => {
  const [f] = await seedValidityCheck.run(
    ctx({ kind: 'field', rule: 'unknown-requester', stem: 'MMR-s1', value: 'GHOST' }),
  );
  expect(f?.severity).toBe('error');
  expect(f?.message).toMatch(/nulled on read/);
});

test('malformed-upstream is error (nulled on read) but dangling-upstream is warn (surfaced only)', async () => {
  const [malformed] = await upstreamRefCheck.run(
    ctx({ kind: 'field', rule: 'malformed-upstream', stem: 'MMR-1', value: 'nope' }),
  );
  expect(malformed?.severity).toBe('error');
  const [dangling] = await upstreamRefCheck.run(
    ctx({ kind: 'field', rule: 'dangling-upstream', stem: 'MMR-1', value: 'MMR-s9' }),
  );
  expect(dangling?.severity).toBe('warn');
  expect(dangling?.message).toMatch(/surfaced for repair/);
});
