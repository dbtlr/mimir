import { expect, test } from 'bun:test';

import type { Drop } from '../core/validate';
import type { DoctorContext } from './checks';
import { CHECKS, RULE_OWNER } from './checks';

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
  switch (rule) {
    case 'dangling-parent':
    case 'dangling-depends-on':
    case 'cycle-parent':
    case 'cycle-depends-on':
      return { kind: 'edge', ref: 'MMR-9', rule, stem };
    case 'missing-project':
      return { key: 'MMR', kind: 'node', rule, stem };
    case 'invalid-lifecycle':
    case 'invalid-hold':
      return { key: 'MMR', kind: 'node', rule, stem, value: 'bogus' };
    case 'invalid-priority':
    case 'invalid-size':
    case 'invalid-open-ended':
      return { kind: 'field', rule, stem, value: 'bogus' };
  }
}

const ctxWith = (drop: Drop): DoctorContext => ({
  dropped: [drop],
  readNodeDocs: () => Promise.resolve([]),
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
