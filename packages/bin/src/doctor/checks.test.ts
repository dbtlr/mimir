import { expect, test } from 'bun:test';

import type { ProjectDeclaration } from '../core/store-norn';
import type { Drop } from '../core/validate';
import type { DoctorContext } from './checks';
import { CHECKS, frontmatterCheck, RULE_OWNER, stemProjectCheck } from './checks';

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
  if (rule === 'missing-project' || rule === 'orphaned-seed') {
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
    rule === 'archived-requester' ||
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

// MMR-244: a seed doc (KEY/seeds/KEY-sN.md) is a work-state document too, so a
// parse-failed / untyped one must reach frontmatterCheck via workStateStem.
const frontmatterCtx = (validateFindings: DoctorContext['validateFindings']): DoctorContext => ({
  dropped: [],
  projectRefs: [],
  readNodeDocs: () => Promise.resolve([]),
  sectionFailures: [],
  validateFindings,
});

test('frontmatter renders a parse-failed seed doc under KEY/seeds/KEY-sN.md (MMR-244)', async () => {
  const findings = await frontmatterCheck.run(
    frontmatterCtx([{ code: 'frontmatter-parse-failed', path: 'MMR/seeds/MMR-s1.md' }]),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ check: 'frontmatter', node: 'MMR-s1', severity: 'error' });
});

test('frontmatter renders an untyped seed doc; a seed stem outside /seeds/ is not one (MMR-244)', async () => {
  const typed = await frontmatterCheck.run(
    frontmatterCtx([
      { code: 'frontmatter-required-field-missing', field: 'type', path: 'MMR/seeds/MMR-s2.md' },
    ]),
  );
  expect(typed).toHaveLength(1);
  expect(typed[0]).toMatchObject({ node: 'MMR-s2', where: 'frontmatter · type' });
  // A seed stem in the wrong directory (not KEY/seeds/) is not a work-state doc.
  const misplaced = await frontmatterCheck.run(
    frontmatterCtx([{ code: 'frontmatter-parse-failed', path: 'MMR/MMR-s3.md' }]),
  );
  expect(misplaced).toEqual([]);
});

test('frontmatter renders a foreign-`type` node under either norn foreign-value code (NRN-235)', async () => {
  // norn 0.47 renamed the foreign-value code `frontmatter-disallowed-value` ->
  // `value-not-allowed`; both keys must render the untyped finding (dual-key tolerance).
  const current = await frontmatterCheck.run(
    frontmatterCtx([{ code: 'value-not-allowed', field: 'type', path: 'MMR/MMR-5.md' }]),
  );
  expect(current).toHaveLength(1);
  expect(current[0]).toMatchObject({ node: 'MMR-5', where: 'frontmatter · type' });
  const legacy = await frontmatterCheck.run(
    frontmatterCtx([{ code: 'frontmatter-disallowed-value', field: 'type', path: 'MMR/MMR-6.md' }]),
  );
  expect(legacy).toHaveLength(1);
  expect(legacy[0]).toMatchObject({ node: 'MMR-6', where: 'frontmatter · type' });
});
