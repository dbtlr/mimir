import { expect, test } from 'bun:test';

import type { ProjectDeclaration } from '../core/store-norn';
import type { Drop } from '../core/validate';
import type { DoctorContext } from './checks';
import { CHECKS, frontmatterCheck, RULE_OWNER, seqGapCheck, stemProjectCheck } from './checks';
import { REPAIR_POLICY } from './repair';

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
  if (rule === 'duplicate-stem') {
    const paths = ['MMR/MMR-1.md', 'archive/MMR-1.md'];
    return { kind: 'identity', path: paths[0]!, paths, rule, stem };
  }
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

// MMR-197: interior seq gaps — a missing number below a project's max seq is
// durable evidence of a hand deletion (Mimir never reuses a seq).
const seqCtx = (stems: string[]): DoctorContext => ({
  dropped: [],
  projectRefs: [],
  readNodeDocs: () =>
    Promise.resolve(stems.map((stem) => ({ body: '', path: `${stem}.md`, stem }))),
  sectionFailures: [],
  validateFindings: [],
});

test('seq-gaps flags an interior node gap and names the missing number (MMR-197)', async () => {
  const findings = await seqGapCheck.run(seqCtx(['MMR', 'MMR-1', 'MMR-2', 'MMR-4', 'MMR-5']));
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'seq-gaps',
    code: 'interior-seq-gap',
    node: 'MMR',
    scopeKey: 'MMR',
    severity: 'warn',
    where: 'node sequence',
  });
  expect(findings[0]?.evidence).toMatchObject({
    kind: 'node',
    max: 5,
    missing: [3],
    missingCount: 1,
  });
  expect(findings[0]?.message).toContain('3');
  expect(findings[0]?.message).toContain('max 5');
});

test('seq-gaps is silent on a gapless project (MMR-197)', async () => {
  const findings = await seqGapCheck.run(seqCtx(['MMR', 'MMR-1', 'MMR-2', 'MMR-3']));
  expect(findings).toEqual([]);
});

test('seq-gaps reports nothing when only the top number was deleted (MMR-197)', async () => {
  // {1,2} with 3 removed: max is 2, present by definition — the deleted top left
  // no interior hole, so this delete-max case is knowingly undetectable (ADR 0017).
  const findings = await seqGapCheck.run(seqCtx(['MMR', 'MMR-1', 'MMR-2']));
  expect(findings).toEqual([]);
});

test('seq-gaps treats node and seed sequences independently (MMR-197)', async () => {
  // Node 2 deleted (gap), seeds contiguous → exactly one finding, for the node seq.
  const findings = await seqGapCheck.run(seqCtx(['MMR', 'MMR-1', 'MMR-3', 'MMR-s1', 'MMR-s2']));
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ severity: 'warn', where: 'node sequence' });
  expect(findings[0]?.evidence).toMatchObject({ kind: 'node', missing: [2] });
});

test('seq-gaps flags a seed gap below its own max (MMR-197)', async () => {
  const findings = await seqGapCheck.run(seqCtx(['MMR', 'MMR-s1', 'MMR-s3']));
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ node: 'MMR', where: 'seed sequence' });
  expect(findings[0]?.evidence).toMatchObject({ kind: 'seed', max: 3, missing: [2] });
});

test('seq-gaps scopes gaps per project (MMR-197)', async () => {
  const findings = await seqGapCheck.run(
    seqCtx(['MMR', 'MMR-1', 'MMR-3', 'OTH', 'OTH-1', 'OTH-2']),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ node: 'MMR', scopeKey: 'MMR' });
});

test('seq-gaps caps the enumerated missing list for a decimated project (MMR-197)', async () => {
  // Only seq 100 survives: 1..99 are all interior gaps; evidence stays bounded and
  // records the true total plus the overflow.
  const findings = await seqGapCheck.run(seqCtx(['MMR', 'MMR-100']));
  expect(findings).toHaveLength(1);
  const missing = findings[0]?.evidence.missing as number[];
  expect(missing).toHaveLength(32);
  expect(findings[0]?.evidence).toMatchObject({ missingCount: 99, truncated: 67 });
  expect(findings[0]?.message).toContain('more');
});

test('interior-seq-gap is informational and never repaired by --fix (MMR-197)', () => {
  expect(REPAIR_POLICY['interior-seq-gap']).toEqual({
    kind: 'skipped',
    reason: 'non-corruption-warning',
  });
});
