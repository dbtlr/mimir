import { expect, test } from 'bun:test';

import type { ProjectDeclaration } from '../core/store-norn';
import type { Drop } from '../core/validate';
import type { DoctorContext } from './checks';
import { CHECKS, RULE_OWNER, stemProjectCheck } from './checks';

/**
 * MMR-209: the drop→check partition is total and non-overlapping — every
 * `Drop['rule']` renders in exactly one registered check, and that check is the
 * one {@link RULE_OWNER} names. `RULE_OWNER` gives the compile-time half (a new
 * rule is a type error there until routed); this gives the runtime half (the
 * routed check actually renders it), so the two cannot drift and no rule can
 * silently render in zero checks.
 */

/** A minimal, valid {@link Drop} of the given rule — enough for the owning check
 * to render a finding. */
function dropOf(rule: Drop['rule']): Drop {
  const stem = 'MMR-1';
  if (rule === 'missing-project') {
    return { key: 'MMR', kind: 'node', rule, stem };
  }
  if (
    rule === 'invalid-lifecycle' ||
    rule === 'invalid-hold' ||
    rule === 'invalid-seed-kind' ||
    rule === 'invalid-seed-lifecycle'
  ) {
    return { key: 'MMR', kind: 'node', rule, stem, value: 'bogus' };
  }
  if (
    rule === 'invalid-priority' ||
    rule === 'invalid-size' ||
    rule === 'invalid-open-ended' ||
    rule === 'unknown-requester' ||
    rule === 'malformed-upstream' ||
    rule === 'dangling-upstream'
  ) {
    return { kind: 'field', rule, stem, value: 'bogus' };
  }
  // The four edge rules: dangling / cycle × parent / depends-on. A new non-edge
  // rule that reaches here is a compile error (not an edge variant) — the nudge
  // to extend this factory.
  return { kind: 'edge', ref: 'MMR-9', rule, stem };
}

const ctxWith = (drop: Drop): DoctorContext => ({
  dropped: [drop],
  projectRefs: [],
  readNodeDocs: () => Promise.resolve([]),
  sectionFailures: [],
  validateFindings: [],
});

test('every Drop rule renders in exactly one check — the one RULE_OWNER names (MMR-209)', async () => {
  for (const rule of Object.keys(RULE_OWNER) as Drop['rule'][]) {
    const firing: string[] = [];
    for (const check of CHECKS) {
      const findings = await check.run(ctxWith(dropOf(rule)));
      if (findings.length > 0) {
        firing.push(check.name);
      }
    }
    // Exactly one check fires (no gap, no leak) …
    expect(firing).toHaveLength(1);
    // … and it is the check RULE_OWNER routes the rule to (no drift).
    expect(firing[0]).toBe(RULE_OWNER[rule]);
  }
});

// MMR-231: stem-vs-declared-project divergence.
const stemProjectCtx = (projectRefs: ProjectDeclaration[]): DoctorContext => ({
  dropped: [],
  projectRefs,
  readNodeDocs: () => Promise.resolve([]),
  sectionFailures: [],
  validateFindings: [],
});

test('stem-project flags a node whose project diverges from its stem key (MMR-231)', async () => {
  const findings = await stemProjectCheck.run(stemProjectCtx([{ project: 'OTH', stem: 'MMR-2' }]));
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ node: 'MMR-2', severity: 'warn' });
  expect(findings[0]?.message).toContain('OTH');
  expect(findings[0]?.message).toContain('MMR');
});

test('stem-project flags a project doc whose project is not self-referential (MMR-231)', async () => {
  const findings = await stemProjectCheck.run(stemProjectCtx([{ project: 'OTH', stem: 'MMR' }]));
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ node: 'MMR', severity: 'warn' });
});

test('stem-project is silent on a matching project, a missing one, and an unparseable stem (MMR-231)', async () => {
  const findings = await stemProjectCheck.run(
    stemProjectCtx([
      { project: 'MMR', stem: 'MMR-2' }, // matches → fine
      { project: 'MMR', stem: 'MMR' }, // self-referential project doc → fine
      { project: null, stem: 'MMR-3' }, // missing → norn's required-field concern (MMR-191)
      { project: 'MMR', stem: 'loose-note' }, // no work-state identity → skipped
    ]),
  );
  expect(findings).toEqual([]);
});
