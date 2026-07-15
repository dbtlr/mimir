import { expect, test } from 'bun:test';

import { parseIdentity } from '../core/ids';
import type { ProjectDeclaration } from '../core/store-norn';
import type { Drop } from '../core/validate';
import type { DoctorContext } from './checks';
import {
  artifactDuplicateStemCheck,
  CHECKS,
  frontmatterCheck,
  RULE_OWNER,
  seqGapCheck,
  stemProjectCheck,
} from './checks';
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
  readArtifactDocs: () => Promise.resolve([]),
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
  readArtifactDocs: () => Promise.resolve([]),
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
  readArtifactDocs: () => Promise.resolve([]),
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
// durable evidence of a hand deletion (Mimir operations never delete, so gaps only
// come from hand edits).
const seqCtx = (
  stems: string[],
  extra: Partial<Pick<DoctorContext, 'dropped' | 'validateFindings'>> = {},
): DoctorContext => {
  // Artifact stems (KEY-aN) feed the artifact-only enumeration; everything else
  // (projects, nodes, seeds) feeds the work-state node read (MMR-282).
  const artifacts = stems.filter((stem) => parseIdentity(stem)?.kind === 'artifact');
  const nodes = stems.filter((stem) => parseIdentity(stem)?.kind !== 'artifact');
  return {
    dropped: extra.dropped ?? [],
    projectRefs: [],
    readArtifactDocs: () =>
      Promise.resolve(artifacts.map((stem) => ({ path: `${stem}.md`, stem }))),
    readNodeDocs: () =>
      Promise.resolve(nodes.map((stem) => ({ body: '', path: `${stem}.md`, stem }))),
    sectionFailures: [],
    validateFindings: extra.validateFindings ?? [],
  };
};

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

test('seq-gaps does not flag a gap whose seq is a present-but-unreadable doc (MMR-197)', async () => {
  // MMR-3 exists on disk but its frontmatter won't parse, so it is excluded from the
  // type-filtered snapshot and reads as absent. Norn's schema pass sees it by path,
  // and the frontmatter check reports it (`validateFindings`) — so this is not a
  // hand-deletion gap. Subtracting the covered seq yields no seq-gap finding.
  const findings = await seqGapCheck.run(
    seqCtx(['MMR', 'MMR-1', 'MMR-2', 'MMR-4'], {
      validateFindings: [{ code: 'frontmatter-parse-failed', path: 'MMR/MMR-3.md' }],
    }),
  );
  expect(findings).toEqual([]);
});

test('seq-gaps does not flag a gap whose seq is a duplicate-stem drop (MMR-197)', async () => {
  // MMR-2 physically exists but was dropped as a duplicate stem — surfaced by its own
  // drop finding, not a deletion. It is subtracted before the gap is reported.
  const findings = await seqGapCheck.run(
    seqCtx(['MMR', 'MMR-1', 'MMR-3'], {
      dropped: [
        {
          kind: 'identity',
          path: 'MMR/MMR-2.md',
          paths: ['MMR/MMR-2.md', 'MMR/dup/MMR-2.md'],
          rule: 'duplicate-stem',
          stem: 'MMR-2',
        },
      ],
    }),
  );
  expect(findings).toEqual([]);
});

test('seq-gaps ignores an out-of-scope duplicate-stem drop (MMR-197)', async () => {
  // Drops are whole-vault while readNodeDocs honors `-s`: a scoped run (only MMR
  // docs in scope) must not let a foreign project's dup drop invent an XYZ group
  // and report gaps the operator never asked about.
  const findings = await seqGapCheck.run(
    seqCtx(['MMR', 'MMR-1', 'MMR-2'], {
      dropped: [
        {
          kind: 'identity',
          path: 'XYZ/XYZ-3.md',
          paths: ['XYZ/XYZ-3.md', 'XYZ/dup/XYZ-3.md'],
          rule: 'duplicate-stem',
          stem: 'XYZ-3',
        },
      ],
    }),
  );
  expect(findings).toEqual([]);
});

test('seq-gaps reports a gap below an unreadable max (surfaced seq is occupied) (MMR-197)', async () => {
  // Readable MMR-1, unreadable MMR-3 (present-but-unexcluded, surfaced by the
  // frontmatter check), genuinely deleted MMR-2. The surfaced seq 3 is an occupied
  // member of the group, so it lifts the group's max to 3 and the real hole at 2 is
  // reported. (Before the union fix, surfaced seqs only suppressed gaps: max stayed
  // 1 and the gap at 2 was invisible.)
  const findings = await seqGapCheck.run(
    seqCtx(['MMR', 'MMR-1'], {
      validateFindings: [{ code: 'frontmatter-parse-failed', path: 'MMR/MMR-3.md' }],
    }),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.evidence).toMatchObject({
    kind: 'node',
    max: 3,
    missing: [2],
    missingCount: 1,
  });
});

test('seq-gaps bounds the computation for an absurd surfaced max (MMR-197)', async () => {
  // One readable doc plus a surfaced seq at an enormous number: the gap count is
  // derived arithmetically from interval sizes (no per-number loop over ~5e6), and
  // the enumerated evidence stays capped. Guards against a hand-crafted stem forcing
  // a billion iterations / a huge missing[].
  const start = performance.now();
  const findings = await seqGapCheck.run(
    seqCtx(['MMR', 'MMR-1'], {
      validateFindings: [{ code: 'frontmatter-parse-failed', path: 'MMR/MMR-5000000.md' }],
    }),
  );
  const elapsedMs = performance.now() - start;
  expect(findings).toHaveLength(1);
  const missing = findings[0]?.evidence.missing as number[];
  expect(missing).toHaveLength(32);
  expect(missing[0]).toBe(2); // 1 is occupied; the first hole is 2
  expect(findings[0]?.evidence).toMatchObject({
    max: 5_000_000,
    missingCount: 4_999_998,
    truncated: 4_999_966,
  });
  expect(elapsedMs).toBeLessThan(1000);
});

test('seq-gaps still reports a genuinely deleted seq beside a surfaced one (MMR-197)', async () => {
  // MMR-2 is a present-but-unreadable doc (surfaced by the frontmatter check); MMR-3
  // has no covering evidence — a real hand deletion. Only 3 is reported.
  const findings = await seqGapCheck.run(
    seqCtx(['MMR', 'MMR-1', 'MMR-4'], {
      validateFindings: [{ code: 'frontmatter-parse-failed', path: 'MMR/MMR-2.md' }],
    }),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.evidence).toMatchObject({ kind: 'node', missing: [3] });
  expect(findings[0]?.message).toContain('likely a hand deletion');
});

// MMR-282: cross-directory duplicate artifact stems + the artifact arm of seq-gaps.
// Since MMR-196 a hand-misplaced KEY-aN.md outside KEY/artifacts/ frees its number,
// so a later create can mint the same stem canonically → two docs, one id.
const artifactCtx = (
  artifacts: { stem: string; path: string }[],
  extra: Partial<Pick<DoctorContext, 'validateFindings'>> = {},
): DoctorContext => ({
  dropped: [],
  projectRefs: [],
  readArtifactDocs: () => Promise.resolve(artifacts),
  readNodeDocs: () => Promise.resolve([]),
  sectionFailures: [],
  validateFindings: extra.validateFindings ?? [],
});

test('artifact-duplicate-stems flags one stem at two directories with both paths in evidence (MMR-282)', async () => {
  const findings = await artifactDuplicateStemCheck.run(
    artifactCtx([
      { path: 'MMR/artifacts/MMR-a2.md', stem: 'MMR-a2' },
      { path: 'MMR/MMR-a2.md', stem: 'MMR-a2' }, // misplaced twin
    ]),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'artifact-duplicate-stems',
    code: 'duplicate-artifact-stem',
    node: 'MMR-a2',
    scopeKey: 'MMR',
    severity: 'error',
  });
  // Both physical paths are in the evidence, sorted (localeCompare) for determinism.
  expect(findings[0]?.evidence.paths).toEqual(['MMR/artifacts/MMR-a2.md', 'MMR/MMR-a2.md']);
  expect(findings[0]?.message).toContain('MMR/MMR-a2.md');
  expect(findings[0]?.message).toContain('MMR/artifacts/MMR-a2.md');
  // The locator is a real .md path so the facet/diagnosis anchor it to a file.
  expect(findings[0]?.locator.endsWith('.md')).toBe(true);
});

test('artifact-duplicate-stems is silent on a canonical-only vault (MMR-282)', async () => {
  const findings = await artifactDuplicateStemCheck.run(
    artifactCtx([
      { path: 'MMR/artifacts/MMR-a1.md', stem: 'MMR-a1' },
      { path: 'MMR/artifacts/MMR-a2.md', stem: 'MMR-a2' },
      { path: 'OTH/artifacts/OTH-a1.md', stem: 'OTH-a1' },
    ]),
  );
  expect(findings).toEqual([]);
});

test('artifact-duplicate-stems ignores a type:artifact doc at a non-artifact filename (MMR-282)', async () => {
  // A doc bearing type:artifact but not a KEY-aN filename is a different corruption
  // class (its stem does not parse as an artifact identity) — not this finding.
  const findings = await artifactDuplicateStemCheck.run(
    artifactCtx([
      { path: 'MMR/artifacts/notes.md', stem: 'notes' },
      { path: 'MMR/notes.md', stem: 'notes' },
    ]),
  );
  expect(findings).toEqual([]);
});

test('duplicate-artifact-stem is never repaired by --fix (MMR-282)', () => {
  // Detection only, per ADR 0023: which of two distinct documents survives is a
  // human call, so --fix skips it exactly like the work-state duplicate-stem.
  expect(REPAIR_POLICY['duplicate-artifact-stem']).toEqual({
    kind: 'skipped',
    reason: 'ambiguous-identity',
  });
});

test('seq-gaps flags an interior artifact gap over the same pass (MMR-282)', async () => {
  const findings = await seqGapCheck.run(seqCtx(['MMR', 'MMR-a1', 'MMR-a3']));
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'seq-gaps',
    code: 'interior-seq-gap',
    node: 'MMR',
    scopeKey: 'MMR',
    severity: 'warn',
    where: 'artifact sequence',
  });
  expect(findings[0]?.evidence).toMatchObject({ kind: 'artifact', max: 3, missing: [2] });
  expect(findings[0]?.message).toContain('artifact sequence');
});

test('seq-gaps: a misplaced artifact still occupies its number — no phantom gap (MMR-282)', async () => {
  // MMR-a2 sits OUTSIDE KEY/artifacts/ (the duplicate check owns that story), yet it
  // still occupies seq 2 here, so {1,2,3} has no interior gap. Occupied = any doc
  // bearing the stem ANYWHERE, matching how the duplicate check sees them.
  const findings = await seqGapCheck.run(
    artifactCtx([
      { path: 'MMR/artifacts/MMR-a1.md', stem: 'MMR-a1' },
      { path: 'MMR/MMR-a2.md', stem: 'MMR-a2' }, // misplaced, still occupies 2
      { path: 'MMR/artifacts/MMR-a3.md', stem: 'MMR-a3' },
    ]),
  );
  expect(findings).toEqual([]);
});

test('seq-gaps: a present-but-unreadable artifact seq is occupied, not a gap (MMR-282)', async () => {
  // MMR-a2 fails to parse, so the type:artifact enumeration excludes it; norn's schema
  // pass sees it by path (KEY/artifacts/KEY-aN.md → workStateStem), so it is occupied,
  // not a hand-deletion gap. {1,(2),3} → no finding.
  const findings = await seqGapCheck.run(
    artifactCtx(
      [
        { path: 'MMR/artifacts/MMR-a1.md', stem: 'MMR-a1' },
        { path: 'MMR/artifacts/MMR-a3.md', stem: 'MMR-a3' },
      ],
      { validateFindings: [{ code: 'frontmatter-parse-failed', path: 'MMR/artifacts/MMR-a2.md' }] },
    ),
  );
  expect(findings).toEqual([]);
});

test('seq-gaps reports node and artifact gaps for one project independently (MMR-282)', async () => {
  // A node gap at 2 and an artifact gap at 2, same project, distinct groups.
  const findings = await seqGapCheck.run(seqCtx(['MMR', 'MMR-1', 'MMR-3', 'MMR-a1', 'MMR-a3']));
  expect(findings).toHaveLength(2);
  // Deterministic order: artifact before node (kind localeCompare).
  expect(findings.map((f) => f.evidence.kind)).toEqual(['artifact', 'node']);
  expect(findings.every((f) => f.node === 'MMR' && f.severity === 'warn')).toBe(true);
});
