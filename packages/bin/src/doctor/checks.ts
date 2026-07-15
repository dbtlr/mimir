/**
 * The `mimir doctor` check registry (MMR-166). Doctor is a vault diagnostics
 * surface: each check is an independent {@link Diagnostic} that inspects the
 * vault and reports {@link DoctorFinding}s for a human to fix. This slice ships
 * one check — body-section record integrity — with the registry structured so
 * siblings (orphans, acyclicity, backend parity, …) register the same way
 * without touching the runner (MMR-169).
 */
import type { BodyRecordProblem } from '../core/history-codec';
import { lintBodySections } from '../core/history-codec';
import { parseIdentity } from '../core/ids';
import type { ProjectDeclaration } from '../core/store-norn';
import type { Drop } from '../core/validate';
import type { ValidateFinding } from '../norn/decode';
import { stemOf } from '../norn/decode';

/** What a check reads: the raw vault documents to diagnose. */
export type DoctorContext = {
  /** Every work-state document's raw markdown and exact path — filtered to
   * `-s` by canonical stem after a whole-vault enumeration (MMR-240). */
  readNodeDocs: () => Promise<{ stem: string; body: string; path: string }[]>;
  /** The shared validator's `dropped[]` over the whole-vault graph — computed
   * once by the runner and fed to every referential check, so the four checks
   * that render `dropped[]` (dangling / missing-project / acyclicity / field
   * validity) share one `validate` pass instead of recomputing it each
   * (MMR-182). Always whole-vault: a referential failure breaks the whole load,
   * so it is global, not scoped. */
  dropped: readonly Drop[];
  /** norn's own `vault.validate` findings, decoded (MMR-191). The one source for
   * documents that never reach {@link dropped}: a doc whose frontmatter fails to
   * parse or carries no `type` is absent from the graph the reader enumerates,
   * so only norn's schema pass sees it. Pre-scoped by `-s` in the runner (a
   * per-document check, unlike the whole-vault `dropped`). */
  validateFindings: readonly ValidateFinding[];
  /** Every parsed doc's declared `project` frontmatter vs its stem — the input for
   * the stem-vs-project divergence check (MMR-231). Always WHOLE-VAULT: a scoped
   * read filters on the very `project` field a divergence corrupts, so it would
   * drop exactly the docs this must catch (a divergent doc falls out of `-s <real
   * KEY>` and into `-s <wrong KEY>`). */
  projectRefs: readonly ProjectDeclaration[];
  /** Documents whose `## History`/`## Annotations` heading norn cannot resolve —
   * a hand-edited duplicate (ambiguous) or a missing heading — so the section reads
   * as EMPTY (ADR 0017). The input for the section-resolution check (MMR-239); each
   * is `{ path, stem, section }`. Filtered to `-s` by canonical stem in the runner. */
  sectionFailures: readonly { path: string; stem: string; section: string }[];
};

/** One problem a check found, anchored for a human to locate and fix. */
export type DoctorFinding = {
  /** Stable machine code. The total repair registry is keyed by this union. */
  code: DoctorIssueCode;
  /** The reporting check's {@link Diagnostic.name}. */
  check: string;
  /** An informational triage label, never a gate (ADR 0017): `error` = a record
   * the reader drops (data lost/hidden on read); `warn` = content the reader
   * tolerates but that looks like an intended record. Doctor always exits 0 on a
   * successful run regardless of severity. */
  severity: 'error' | 'warn';
  /** The offending node's `KEY-seq` stem. */
  node: string;
  /** Where in the document, e.g. `History · line 6`. */
  where: string;
  /** A one-line human description of the problem. */
  message: string;
  /** Canonical ownership derived from the stem, never from frontmatter. */
  scopeKey: string;
  /** Canonical entity identity (kept alongside `node` for JSON compatibility). */
  stem: string;
  /** Stable structured facts used by repair policy and machine consumers. */
  evidence: Readonly<Record<string, unknown>>;
  /** Physical or logical location of the issue. */
  locator: string;
};

/** Every issue code the diagnostic registry can emit. Including Drop['rule']
 * makes a validator rule addition expand this union automatically; the repair
 * policy's Record then fails compilation until the rule is classified. */
export type DoctorIssueCode =
  | Drop['rule']
  | BodyRecordProblem
  | 'crlf-body'
  | 'frontmatter-disallowed-value'
  | 'frontmatter-parse-failed'
  | 'frontmatter-required-field-missing'
  | 'interior-seq-gap'
  | 'section-annotations-unreadable'
  | 'section-history-unreadable'
  | 'stem-project-divergence'
  | 'value-not-allowed';

type FindingInput = Omit<DoctorFinding, 'code' | 'evidence' | 'locator' | 'scopeKey' | 'stem'> & {
  code: DoctorIssueCode;
  evidence?: Readonly<Record<string, unknown>>;
  locator?: string;
};

/** Build the additive structured issue envelope while preserving the original
 * human/JSON finding fields. */
function issue(input: FindingInput): DoctorFinding {
  const identity = parseIdentity(input.node);
  return {
    ...input,
    evidence: input.evidence ?? {},
    locator: input.locator ?? input.where,
    scopeKey: identity?.key ?? input.node,
    stem: input.node,
  };
}

/** A registered diagnostic: a named check over the vault. A check is sync when it
 * reads only the pre-computed {@link DoctorContext.dropped}, async when it reads
 * raw docs; the runner awaits either. */
export type Diagnostic = {
  name: string;
  title: string;
  run: (ctx: DoctorContext) => DoctorFinding[] | Promise<DoctorFinding[]>;
};

/**
 * Per-problem severity + message. The read path (MMR-161) is deliberately
 * tolerant: an unescaped `### ` line that isn't a valid record boundary stays as
 * the enclosing record's content — preserved, not lost. So only a genuinely
 * *dropped* record is an `error` (a valid heading whose record the reader filters
 * out, losing the transition); a heading-shaped line the reader keeps as text is
 * a `warn` — it reads fine, but it looks like a record a hand edit may have meant.
 * The label is informational triage only — neither severity gates (ADR 0017).
 */
const PROBLEM: Record<BodyRecordProblem, { severity: DoctorFinding['severity']; message: string }> =
  {
    'malformed-history-heading': {
      message:
        'looks like a history record heading but is not one — read as text, not a transition',
      severity: 'warn',
    },
    'non-iso-annotation-heading': {
      message: 'looks like an annotation heading but is not an ISO-8601 timestamp — read as text',
      severity: 'warn',
    },
    'unknown-transition-kind': {
      message: 'history heading has an unknown transition kind — read as text, not a transition',
      severity: 'warn',
    },
    'unparseable-history-record': {
      message: 'history record dropped on read — missing or unparseable edge line',
      severity: 'error',
    },
  };

/**
 * Body-section record integrity: scan each node/project body for malformed
 * `## History` / `## Annotations` records. An `error` is a record the reader
 * drops (a lost transition); a `warn` is a heading-shaped line the reader keeps
 * as content but that looks like an intended record — surfaced for a human, not
 * a gate.
 */
export const bodySectionCheck: Diagnostic = {
  name: 'body-sections',
  run: async (ctx) => {
    const findings: DoctorFinding[] = [];
    for (const { stem, body, path } of await ctx.readNodeDocs()) {
      for (const f of lintBodySections(body)) {
        const { message, severity } = PROBLEM[f.problem];
        findings.push(
          issue({
            check: 'body-sections',
            code: f.problem,
            evidence: { heading: f.heading, line: f.line, section: f.section },
            locator: path,
            message: `${message} — ${f.heading}`,
            node: stem,
            severity,
            where: `${f.section} · line ${String(f.line)}`,
          }),
        );
      }
    }
    return findings;
  },
  title: 'Body-section record integrity',
};

/**
 * CRLF hygiene (MMR-176): a document body whose lines end in CRLF (`\r\n`). Since
 * MMR-167 the codec reads canonical-LF (`splitLines` tolerates `\r\n`), so CRLF
 * is cosmetic — it reads fine — but non-canonical: a Windows editor or git
 * `autocrlf` left it, and the render path writes LF, so the next mutation
 * rewrites the whole file. A `warn` (surfaced, never gating). Per-document, so it
 * honors `-s`, like the body-section check.
 */
export const crlfCheck: Diagnostic = {
  name: 'crlf',
  run: async (ctx) => {
    const findings: DoctorFinding[] = [];
    for (const { stem, body, path } of await ctx.readNodeDocs()) {
      const count = (body.match(/\r\n/g) ?? []).length;
      if (count > 0) {
        findings.push(
          issue({
            check: 'crlf',
            code: 'crlf-body',
            evidence: { count },
            locator: path,
            message: `body uses CRLF line endings (${String(count)}) — tolerated on read (MMR-167) but non-canonical`,
            node: stem,
            severity: 'warn',
            where: 'body',
          }),
        );
      }
    }
    return findings;
  },
  title: 'CRLF line endings',
};

/** The referential/field checks that render {@link Drop} entries. */
type DropCheckName =
  | 'identity-uniqueness'
  | 'dangling-refs'
  | 'missing-project'
  | 'acyclicity'
  | 'field-validity'
  | 'seed-validity'
  | 'upstream-refs';

/**
 * The check that renders each {@link Drop} rule — the drop→check partition made
 * total and explicit (MMR-209). Keyed by `Drop['rule']`, so a new rule added to
 * the Drop union (`core/validate.ts`) is a COMPILE error here until it is routed
 * to a check. That closes the silent gap the four referential/field checks left:
 * each hand-filtered `dropped` by rule literal and `fieldValidityCheck`'s else
 * silently continued, so a new rule would render in NO check and vanish from
 * every finding. Those checks now derive their slice from this map (via
 * {@link ownsDrop}) instead of re-listing rules, so routing lives in one place;
 * the companion "rendered by exactly one check" half is enforced against the live
 * checks by an exhaustiveness test (`checks.test.ts`).
 */
export const RULE_OWNER: Record<Drop['rule'], DropCheckName> = {
  'archived-requester': 'seed-validity',
  'cycle-depends-on': 'acyclicity',
  'cycle-parent': 'acyclicity',
  'dangling-depends-on': 'dangling-refs',
  'dangling-parent': 'dangling-refs',
  // Seeds (MMR-244): seed-doc rules → seed-validity, task upstream → upstream-refs.
  'dangling-spawned': 'seed-validity',
  'dangling-upstream': 'upstream-refs',
  'duplicate-stem': 'identity-uniqueness',
  'invalid-hold': 'field-validity',
  'invalid-lifecycle': 'field-validity',
  'invalid-open-ended': 'field-validity',
  'invalid-priority': 'field-validity',
  'invalid-seed-kind': 'seed-validity',
  'invalid-seed-lifecycle': 'seed-validity',
  'invalid-size': 'field-validity',
  'malformed-upstream': 'upstream-refs',
  'missing-project': 'missing-project',
  'orphaned-seed': 'seed-validity',
  'unknown-requester': 'seed-validity',
};

/** Does `drop` belong to the named check? The single routing authority the
 * referential/field checks filter on, so the {@link RULE_OWNER} partition and the
 * checks cannot drift (MMR-209). */
const ownsDrop = (drop: Drop, name: DropCheckName): boolean => RULE_OWNER[drop.rule] === name;

/** Canonical work-state identities must resolve to exactly one physical path. */
export const identityUniquenessCheck: Diagnostic = {
  name: 'identity-uniqueness',
  run: (ctx) =>
    ctx.dropped.flatMap((drop) => {
      if (!ownsDrop(drop, 'identity-uniqueness') || drop.kind !== 'identity') {
        return [];
      }
      return [
        issue({
          check: 'identity-uniqueness',
          code: drop.rule,
          evidence: { excludedPath: drop.path, paths: drop.paths },
          message: `duplicate stem ${drop.stem} at ${drop.paths.join(', ')} — ${drop.path} is excluded from reads`,
          node: drop.stem,
          severity: 'error' as const,
          where: drop.path,
        }),
      ];
    }),
  title: 'Canonical identity uniqueness',
};

/**
 * Dangling relational references (MMR-169): a node whose `parent` (a `KEY-seq`)
 * or `depends_on` resolves to no surviving node in the vault. Since MMR-181 the
 * resolving reader tolerates this — it drops the edge and loads a valid subgraph
 * (`store-norn.ts`) — so it is data loss on read, not a failed load: doctor
 * renders every dangling *edge* the `validate` shared validator (MMR-180)
 * drops, so it enumerates them all. Always an `error`, and whole-vault: a single
 * dangler affects the read regardless of `-s`, so the check ignores scope. A bare
 * project `KEY` parent is
 * a root, not a reference — the validator preserves it; a self-dependency
 * resolves and is {@link acyclicityCheck}'s domain (MMR-174).
 *
 * A thin adapter over the validator: it renders `dropped[]` entries whose `rule`
 * is `dangling-parent`/`dangling-depends-on`. There is exactly one detector —
 * the reader drops the same edges this reports — so they cannot drift.
 */
export const danglingRefCheck: Diagnostic = {
  name: 'dangling-refs',
  run: (ctx) => {
    const findings: DoctorFinding[] = [];
    for (const drop of ctx.dropped) {
      // Routing lives in RULE_OWNER; the `kind` guard narrows for `ref` (only edge
      // variants carry it — the two dangling-* rules this check owns are both edges).
      if (!ownsDrop(drop, 'dangling-refs') || drop.kind !== 'edge') {
        continue;
      }
      const field = drop.rule === 'dangling-parent' ? 'parent' : 'depends_on';
      findings.push(
        issue({
          check: 'dangling-refs',
          code: drop.rule,
          evidence: { field, ref: drop.ref },
          message: `${field} ${drop.ref} resolves to no node in the vault — the reference is dropped on read`,
          node: drop.stem,
          severity: 'error',
          where: `frontmatter · ${field}`,
        }),
      );
    }
    return findings;
  },
  title: 'Dangling relational references',
};

/**
 * Node → project references (MMR-178): a node whose owning project has no
 * document. Every node belongs to the project named by its `KEY-seq` stem's key;
 * since MMR-181 the reader tolerates an absent project doc by hiding the node
 * (and its project siblings) from the read (`store-norn.ts`) — so, like a
 * dangling ref, it is data hidden on read, not a failed load. The companion to
 * {@link danglingRefCheck} over the same `validate` pass: `error`, whole-vault.
 *
 * Reports one finding per *missing project*, not per orphaned node: every node
 * under an absent key shares the one fix (add that project doc), so collapsing
 * the validator's per-node `missing-project` drops keeps the count honest and
 * avoids burying other findings.
 */
export const missingProjectCheck: Diagnostic = {
  name: 'missing-project',
  run: (ctx) => {
    // Collapse the validator's per-node missing-project drops by key → a
    // representative orphaned node + the total under it. Insertion order over the
    // (input-ordered) drops preserves the first-seen node as representative.
    const missing = new Map<string, { node: string; count: number }>();
    for (const drop of ctx.dropped) {
      // `key` is on the missing-project node variant; the guard narrows to it.
      if (!ownsDrop(drop, 'missing-project') || drop.kind !== 'node') {
        continue;
      }
      const seen = missing.get(drop.key);
      if (seen === undefined) {
        missing.set(drop.key, { count: 1, node: drop.stem });
      } else {
        seen.count += 1;
      }
    }
    return Array.from(missing, ([key, { node, count }]) =>
      issue({
        check: 'missing-project',
        code: 'missing-project',
        evidence: { count, key },
        message: `project ${key} has no document in the vault (referenced by ${String(count)} node${count === 1 ? '' : 's'}) — its nodes are hidden on read`,
        node,
        severity: 'error',
        where: 'project',
      }),
    );
  },
  title: 'Node → project references',
};

/**
 * Relational acyclicity (MMR-174): a `parent` or `depends_on` edge that closes a
 * cycle in the vault's relational graph. The resolving loader once threw on the
 * degenerate self-dependency and silently accepted longer cycles (then derived
 * wrongly over them); since MMR-174 acyclicity is a `validate` rule, so the
 * reader drops each cycle-closing (back) edge and loads a valid DAG
 * (`store-norn.ts`) — data loss on read, not a failed load. The sibling of
 * {@link danglingRefCheck} over the same validator pass: it renders `dropped[]`
 * entries whose `rule` is `cycle-parent`/`cycle-depends-on`, so it reports exactly
 * the edges the reader drops — one detector, no drift. Always an `error`, and
 * whole-vault: a cycle corrupts derivation regardless of `-s`, so scope is ignored.
 */
export const acyclicityCheck: Diagnostic = {
  name: 'acyclicity',
  run: (ctx) => {
    const findings: DoctorFinding[] = [];
    for (const drop of ctx.dropped) {
      // Routing lives in RULE_OWNER; the `kind` guard narrows for `ref`.
      if (!ownsDrop(drop, 'acyclicity') || drop.kind !== 'edge') {
        continue;
      }
      const field = drop.rule === 'cycle-parent' ? 'parent' : 'depends_on';
      findings.push(
        issue({
          check: 'acyclicity',
          code: drop.rule,
          evidence: { field, ref: drop.ref },
          message: `${field} ${drop.ref} closes a cycle — the edge is dropped on read`,
          node: drop.stem,
          severity: 'error',
          where: `frontmatter · ${field}`,
        }),
      );
    }
    return findings;
  },
  title: 'Relational acyclicity',
};

/**
 * Node field validity (MMR-177): a task whose `lifecycle`/`hold`/`priority`/`size`
 * frontmatter is missing or foreign. The reader tolerates it (the tiering rule
 * lives in `validate` pass 0): a bad load-bearing field (`lifecycle`/`hold`)
 * drops the whole node, a bad optional field (`priority`/`size`) nulls just the
 * field and the node loads — data hidden/lost on read, not a failed load. A thin
 * adapter over the same validator pass as {@link danglingRefCheck}, rendering the
 * four field rules; every {@link Drop} rule renders in exactly one check, so the
 * referential checks above skip these and this skips theirs — no leak, no gap.
 * Always an `error`, and whole-vault (the graph is unscoped, like its siblings).
 */
export const fieldValidityCheck: Diagnostic = {
  name: 'field-validity',
  run: (ctx) => {
    const findings: DoctorFinding[] = [];
    for (const drop of ctx.dropped) {
      // Routing lives in RULE_OWNER; the branches below narrow for `value`.
      if (!ownsDrop(drop, 'field-validity')) {
        continue;
      }
      let field: string;
      let message: string;
      if (drop.kind === 'node' && drop.rule === 'invalid-lifecycle') {
        field = 'lifecycle';
        message =
          drop.value === null
            ? 'task dropped — missing lifecycle'
            : `task dropped — invalid lifecycle "${drop.value}"`;
      } else if (drop.kind === 'node' && drop.rule === 'invalid-hold') {
        field = 'hold';
        message = `task dropped — invalid hold "${drop.value ?? ''}"`;
      } else if (drop.kind === 'field' && drop.rule === 'invalid-priority') {
        field = 'priority';
        message = `invalid priority "${drop.value}" — field nulled on read (node kept)`;
      } else if (drop.kind === 'field' && drop.rule === 'invalid-size') {
        field = 'size';
        message = `invalid size "${drop.value}" — field nulled on read (node kept)`;
      } else if (drop.kind === 'field' && drop.rule === 'invalid-open-ended') {
        field = 'open_ended';
        message = `invalid open_ended "${drop.value}" — field nulled on read (node kept)`;
      } else {
        // Unreachable: RULE_OWNER routes only the five field rules here, all
        // handled above. A newly routed-but-unrendered rule is caught by the
        // exhaustiveness test rather than silently continuing (MMR-209).
        continue;
      }
      findings.push(
        issue({
          check: 'field-validity',
          code: drop.rule,
          evidence: { field, value: drop.value },
          message,
          node: drop.stem,
          severity: 'error',
          where: `frontmatter · ${field}`,
        }),
      );
    }
    return findings;
  },
  title: 'Node field validity',
};

/**
 * A finding's `path` names a work-state document — and its stem — iff the path
 * matches one of the vault's parent-dir-anchored layouts (the `allowed_paths` in
 * `vault/schema.ts`): a node `KEY/KEY-seq.md`, a project `KEY/KEY.md`, an artifact
 * `KEY/artifacts/KEY-aN.md`, or a seed `KEY/seeds/KEY-sN.md`. Every reader (and
 * every other doctor check) enumerates the vault by `type:`, so a doc whose
 * frontmatter won't parse or has no `type` is invisible to them and reported by
 * norn's schema pass by *path* only. The vault may hold unrelated docs (loose
 * notes, a stray `refs/AB-1.md`), so the anchoring is what keeps the check to real
 * work-state docs — a matching stem in the wrong directory is not one.
 */
export function workStateStem(path: string): string | null {
  const stem = stemOf(path);
  const parts = path.split('/');
  const parent = parts.at(-2);
  const grandparent = parts.at(-3);
  const identity = parseIdentity(stem);
  // A node `KEY/KEY-seq.md`: the parent dir is the node's own project key.
  if (identity?.kind === 'node' && parts.length === 2 && parent === identity.key) {
    return stem;
  }
  // A project `KEY/KEY.md`: the parent dir is that same key.
  if (identity?.kind === 'project' && parts.length === 2 && parent === stem) {
    return stem;
  }
  // An artifact `KEY/artifacts/KEY-aN.md`: parent dir `artifacts`, grandparent
  // the artifact's project key. Artifacts are work-state docs too — a corrupt one
  // is invisible on read, so it belongs here (the finding's node is the KEY-aN).
  if (
    identity?.kind === 'artifact' &&
    parts.length === 3 &&
    parent === 'artifacts' &&
    grandparent === identity.key
  ) {
    return stem;
  }
  // A seed `KEY/seeds/KEY-sN.md` (MMR-244): parent dir `seeds`, grandparent the
  // seed's project key. Seeds are work-state docs too — a parse-failed/untyped one
  // is invisible on read, so it belongs here (the finding's node is the KEY-sN).
  if (
    identity?.kind === 'seed' &&
    parts.length === 3 &&
    parent === 'seeds' &&
    grandparent === identity.key
  ) {
    return stem;
  }
  return null;
}

/**
 * The frontmatter codes this check renders, and how to describe each. These
 * code strings and the `field === "type"` gate on the field-scoped ones are the
 * empirically-verified norn `vault.validate` contract (mimir's generated
 * `.norn/config.yaml` carries the `document-type` rule): a corrupt work-state doc
 * emits `frontmatter-parse-failed` (no field — always qualifies) and, for a
 * missing/foreign type, `frontmatter-required-field-missing`/the foreign-value
 * code with `field: "type"`. norn 0.47 (NRN-235) renamed the foreign-value code
 * `frontmatter-disallowed-value` -> `value-not-allowed`; BOTH keys are kept (mimir
 * has no norn version floor, so dual keys are cheap tolerance for an older norn).
 * The field-scoped codes also fire for other fields (a missing `title`, a foreign
 * `lifecycle`, …), which leave the doc visible — hence the `field` gate. A future
 * norn code rename lands here.
 */
const FRONTMATTER: Record<string, { field: string | null; where: string; message: string }> = {
  // norn <=0.46 emitted `frontmatter-disallowed-value`; 0.47 (NRN-235) renamed it
  // `value-not-allowed` (below). Both keys point at the same spec — a foreign `type`
  // is an untyped doc, invisible to the reader.
  'frontmatter-disallowed-value': {
    field: 'type',
    message:
      'frontmatter `type` is a foreign value — the document is invisible to the reader (untyped)',
    where: 'frontmatter · type',
  },
  'frontmatter-parse-failed': {
    field: null,
    message: 'frontmatter failed to parse — the document is invisible to the reader',
    where: 'frontmatter',
  },
  'frontmatter-required-field-missing': {
    field: 'type',
    message:
      'frontmatter is missing the required `type` field — the document is invisible to the reader',
    where: 'frontmatter · type',
  },
  // The 0.47 (NRN-235) rename of `frontmatter-disallowed-value`; same spec.
  'value-not-allowed': {
    field: 'type',
    message:
      'frontmatter `type` is a foreign value — the document is invisible to the reader (untyped)',
    where: 'frontmatter · type',
  },
};

/**
 * Frontmatter parse-failed + untyped documents (MMR-191): a work-state document
 * (node, project, or artifact) whose frontmatter (a) fails to parse or (b) has a
 * missing/foreign `type`. Such a doc is absent from the `type:`-filtered
 * enumeration every reader and every other check runs on — so it is invisible on
 * read AND to {@link dropped}. Only norn's `vault.validate` (which enumerates by
 * *path*) sees it (ADR 0017). Always an `error` (the doc is dropped from the
 * read); honors `-s` like the per-document checks — an isolated parse failure
 * does not break the whole load, so the runner pre-scopes the findings.
 *
 * A parse-failed doc also emits `required-field-missing(type)` (the missing type
 * is a *consequence* of the unparseable frontmatter), so the check dedups by stem
 * and keeps the parse-failed finding — its message subsumes the type consequence.
 */
export const frontmatterCheck: Diagnostic = {
  name: 'frontmatter',
  run: (ctx) => {
    // Dedup by stem: a parse-failed doc emits BOTH parse-failed and
    // required-missing(type). Keep the parse-failed (the root cause) when a stem
    // has both; first-parse-failed-wins, else first-seen.
    const byStem = new Map<string, DoctorFinding>();
    for (const finding of ctx.validateFindings) {
      const spec = FRONTMATTER[finding.code];
      // Not a code this check renders, or a field-scoped code on a field other
      // than `type` (e.g. a missing `title`, which leaves the doc visible).
      if (spec === undefined || (spec.field !== null && finding.field !== spec.field)) {
        continue;
      }
      if (
        finding.code !== 'frontmatter-disallowed-value' &&
        finding.code !== 'frontmatter-parse-failed' &&
        finding.code !== 'frontmatter-required-field-missing' &&
        finding.code !== 'value-not-allowed'
      ) {
        continue;
      }
      const stem = workStateStem(finding.path);
      if (stem === null) {
        continue; // a non-work-state path (a stray vault doc) — not this check's domain
      }
      const existing = byStem.get(stem);
      const isParseFailed = finding.code === 'frontmatter-parse-failed';
      // Skip unless this is the first finding for the stem, or a parse-failed
      // upgrade over an already-recorded type finding.
      if (existing !== undefined && !(isParseFailed && existing.where !== 'frontmatter')) {
        continue;
      }
      // Parse-failed: append norn's own detail (line/column/conflict-marker).
      const message =
        isParseFailed && finding.message !== undefined && finding.message !== ''
          ? `${spec.message} — ${finding.message}`
          : spec.message;
      byStem.set(
        stem,
        issue({
          check: 'frontmatter',
          code: finding.code,
          evidence: {
            field: finding.field,
            path: finding.path,
            validateCode: finding.code,
          },
          locator: finding.path,
          message,
          node: stem,
          severity: 'error',
          where: spec.where,
        }),
      );
    }
    return [...byStem.values()];
  },
  title: 'Frontmatter parse-failed + untyped documents',
};

/**
 * Stem vs declared project (MMR-231): a doc whose `project` frontmatter is PRESENT
 * but points at a different valid key than its own `KEY-seq` stem. The stem is the
 * authoritative identity; `project` is a query projection of it (MMR-170) that
 * scopes `find --eq project:KEY`. A hand-edit diverging the two is diagnostic-only
 * — the reader derives project from the stem and ignores the field, and `-s all`
 * reads every doc — but it silently MISFILES the doc under scope: it falls OUT of
 * `mimir doctor -s <its real key>` (the scoped read filters on the corrupt field)
 * and INTO `-s <the wrong key>`. Norn's required-field validate (MMR-191) catches a
 * MISSING project, never a present-but-wrong one — so this is the only surface that
 * would. A `warn` (nothing is lost on read); whole-vault, because a scoped read
 * structurally cannot see the misfiled doc (see {@link DoctorContext.projectRefs}).
 */
export const stemProjectCheck: Diagnostic = {
  name: 'stem-project',
  run: (ctx) => {
    const findings: DoctorFinding[] = [];
    for (const { kind, path, project, stem } of ctx.projectRefs) {
      // A missing/malformed `project` is norn's required-field concern (MMR-191).
      if (project === null) {
        continue;
      }
      const canonicalProject = kind === 'project' ? stem : parseIdentity(stem)?.key;
      if (canonicalProject === undefined || canonicalProject === project) {
        continue;
      }
      findings.push(
        issue({
          check: 'stem-project',
          code: 'stem-project-divergence',
          evidence: { actualProject: project, canonicalProject },
          ...(path === undefined ? {} : { locator: path }),
          message: `project ${project} diverges from the stem's key ${canonicalProject} — the doc misfiles under a scoped 'find --eq project:KEY' (the stem is the true owner)`,
          node: stem,
          severity: 'warn',
          where: 'frontmatter · project',
        }),
      );
    }
    return findings;
  },
  title: 'Stem vs declared project',
};

/**
 * Section resolution (MMR-239): a document whose `## History` or `## Annotations`
 * heading norn cannot resolve — a hand-edited DUPLICATE (ambiguous — norn refuses
 * to arbitrarily pick one of two, ADR 0017) or a MISSING heading. Native section
 * reads (`vault.get { section }`) then degrade the section to EMPTY: the
 * transitions feed and the history/annotations facets read nothing, silently. An
 * `error` — records are lost on read; the detector is norn's own resolver (its
 * `section_failures` channel), so it can't drift from what the reader actually
 * sees. A per-document corruption, so it honors `-s` (unlike the whole-vault
 * referential checks).
 */
export const sectionResolutionCheck: Diagnostic = {
  name: 'section-resolution',
  run: (ctx) =>
    ctx.sectionFailures.map(({ path, section, stem }) =>
      issue({
        check: 'section-resolution',
        code:
          section === 'History' ? 'section-history-unreadable' : 'section-annotations-unreadable',
        evidence: { section },
        locator: path,
        message: `${section} section is unreadable — a duplicate (ambiguous) or missing heading resolves to no section, so its records read empty`,
        node: stem,
        severity: 'error',
        where: `body · ${section}`,
      }),
    ),
  title: 'Body-section resolution',
};

/** Bound the enumerated missing-seq list so a pathological project (one whose
 * numbering was decimated by hand) still renders one readable line rather than
 * thousands of numbers; past the cap the finding names the overflow count only. */
const SEQ_GAP_EVIDENCE_CAP = 32;

/**
 * Interior sequence gaps (MMR-197): a project whose node (or seed) sequence is
 * missing an INTERIOR number — one below the sequence's current max. Norn resolves
 * `{{seq}}` as max+1 within the target directory and never gap-fills ([ADR
 * 0006](../../docs/decisions/0006-human-readable-node-ids.md) refinement), and
 * Mimir verbs never delete (abandon is the lifecycle path), so a hole below the
 * max cannot come from a Mimir operation — it is durable evidence of a hand
 * deletion (`rm`). In a single-user vault that deletion is intentional, so the
 * stance is surface-and-repair, not prevent (ADR 0017): recovery is `git revert`
 * over the vault's snapshot history, never a doctor mutation. Rendered at the
 * non-error `warn` tier — the informational severity (nothing is lost on read; the
 * numbering is merely non-contiguous) — and never repairable (`REPAIR_POLICY`
 * skips it as a non-corruption warning).
 *
 * Scans NODE and SEED sequences only. Both are enumerated by the one whole-vault
 * snapshot (`type:project,task,phase,initiative,seed`) and allocate identically
 * since MMR-196, so covering seeds is free. ARTIFACTS (`KEY-aN`) allocate the same
 * way but carry `type: artifact`, absent from that enumeration — the doctor
 * snapshot never reads them, so an artifact-gap check would need a whole new vault
 * pass. That is disproportionate to the data flow, so artifacts are out of scope.
 *
 * The delete-max-then-create edge closes its own gap — the next create reuses the
 * freed top number — and is knowingly undetectable after the fact (ADR 0017); a
 * finding only ever names numbers below the current max, which is present by
 * definition. Honors `-s` like the other per-document checks (`readNodeDocs` is
 * pre-scoped), so a scoped run reports only the named project's gaps.
 */
export const seqGapCheck: Diagnostic = {
  name: 'seq-gaps',
  run: async (ctx) => {
    // Group present seqs by (project key, sequence kind). A duplicate physical doc
    // for one stem contributes its seq once (a Set), so a collision is not a gap.
    const groups = new Map<string, { key: string; kind: 'node' | 'seed'; seqs: Set<number> }>();
    for (const { stem } of await ctx.readNodeDocs()) {
      const identity = parseIdentity(stem);
      if (identity === null || (identity.kind !== 'node' && identity.kind !== 'seed')) {
        continue; // a project doc (no seq), an artifact (unenumerated), or an unparseable stem
      }
      const groupKey = `${identity.key}\0${identity.kind}`;
      const group = groups.get(groupKey);
      if (group === undefined) {
        groups.set(groupKey, {
          key: identity.key,
          kind: identity.kind,
          seqs: new Set([identity.seq]),
        });
      } else {
        group.seqs.add(identity.seq);
      }
    }
    const findings: DoctorFinding[] = [];
    // Deterministic order: by project key, then node before seed.
    const ordered = [...groups.values()].toSorted(
      (a, b) => a.key.localeCompare(b.key) || a.kind.localeCompare(b.kind),
    );
    for (const { key, kind, seqs } of ordered) {
      const max = Math.max(...seqs);
      // Seqs are 1-based (ADR 0006), so an interior gap is any 1..max-1 absent. The
      // max is present by definition; a deleted top left no hole (undetectable).
      const missing: number[] = [];
      for (let n = 1; n < max; n += 1) {
        if (!seqs.has(n)) {
          missing.push(n);
        }
      }
      if (missing.length === 0) {
        continue;
      }
      const shown = missing.slice(0, SEQ_GAP_EVIDENCE_CAP);
      const overflow = missing.length - shown.length;
      const list = `${shown.join(', ')}${overflow > 0 ? `, … (+${String(overflow)} more)` : ''}`;
      findings.push(
        issue({
          check: 'seq-gaps',
          code: 'interior-seq-gap',
          evidence: {
            kind,
            max,
            missing: shown,
            missingCount: missing.length,
            ...(overflow > 0 ? { truncated: overflow } : {}),
          },
          message: `project ${key} is missing interior ${kind} sequence number${missing.length === 1 ? '' : 's'} ${list} below its max ${String(max)} — evidence of a hand deletion (Mimir never reuses a seq; recover with git, ADR 0017)`,
          node: key,
          severity: 'warn',
          where: `${kind} sequence`,
        }),
      );
    }
    return findings;
  },
  title: 'Interior sequence gaps',
};

/**
 * Seed validity (MMR-244, severities revised MMR-245): a seed document's
 * own-project / `kind` / `lifecycle` / `requester` / `spawned`. The seed STORE
 * reads verbatim (like the artifact store): only a foreign/missing
 * `kind`/`lifecycle` drops the record there (its `toRecord` returns null). Since
 * MMR-245 the verb-facing read seam (`listSeeds`/`getSeed`) is the second reader:
 * it hides an orphaned seed, nulls an unknown `requester`, and prunes a dangling
 * `spawned` — so all four are now data lost/hidden on read. A thin adapter over
 * the shared validator's seed rules — one detector, so it can't drift from the
 * validator. Mostly `error` (the reader drops/nulls the record or reference — the
 * severity means exactly "the reader drops it"), except `archived-requester`,
 * which is a `warn`: the requester names a known-but-archived board, nulled on read
 * but reverting on unarchive (MMR-245/B1d). Whole-vault (the graph is unscoped,
 * like its referential siblings).
 */
export const seedValidityCheck: Diagnostic = {
  name: 'seed-validity',
  run: (ctx) => {
    const findings: DoctorFinding[] = [];
    for (const drop of ctx.dropped) {
      if (!ownsDrop(drop, 'seed-validity')) {
        continue;
      }
      if (drop.kind === 'node' && drop.rule === 'orphaned-seed') {
        findings.push(
          issue({
            check: 'seed-validity',
            code: drop.rule,
            evidence: { key: drop.key },
            message: `project ${drop.key} has no document in the vault — the seed is hidden on read`,
            node: drop.stem,
            severity: 'error',
            where: 'project',
          }),
        );
      } else if (drop.kind === 'node' && drop.rule === 'invalid-seed-kind') {
        findings.push(
          issue({
            check: 'seed-validity',
            code: drop.rule,
            evidence: { value: drop.value },
            message:
              drop.value === null
                ? 'seed dropped — missing kind'
                : `seed dropped — invalid kind "${drop.value}"`,
            node: drop.stem,
            severity: 'error',
            where: 'frontmatter · kind',
          }),
        );
      } else if (drop.kind === 'node' && drop.rule === 'invalid-seed-lifecycle') {
        findings.push(
          issue({
            check: 'seed-validity',
            code: drop.rule,
            evidence: { value: drop.value },
            message:
              drop.value === null
                ? 'seed dropped — missing lifecycle'
                : `seed dropped — invalid lifecycle "${drop.value}"`,
            node: drop.stem,
            severity: 'error',
            where: 'frontmatter · lifecycle',
          }),
        );
      } else if (drop.kind === 'field' && drop.rule === 'unknown-requester') {
        findings.push(
          issue({
            check: 'seed-validity',
            code: drop.rule,
            evidence: { value: drop.value },
            message: `requester ${drop.value} is not a known project — nulled on read (self-filed)`,
            node: drop.stem,
            severity: 'error',
            where: 'frontmatter · requester',
          }),
        );
      } else if (drop.kind === 'field' && drop.rule === 'archived-requester') {
        // A KNOWN but archived requester: the reader nulls it (active-only
        // visibility), yet it reverts on unarchive — surfaced for awareness, not
        // corruption, so `warn` (matches the `dangling-upstream` warn precedent).
        findings.push(
          issue({
            check: 'seed-validity',
            code: drop.rule,
            evidence: { value: drop.value },
            message: `requester ${drop.value} is archived — nulled on read (reverts on unarchive)`,
            node: drop.stem,
            severity: 'warn',
            where: 'frontmatter · requester',
          }),
        );
      } else if (drop.kind === 'edge' && drop.rule === 'dangling-spawned') {
        findings.push(
          issue({
            check: 'seed-validity',
            code: drop.rule,
            evidence: { ref: drop.ref },
            message: `spawned ${drop.ref} resolves to no node in the vault — pruned on read`,
            node: drop.stem,
            severity: 'error',
            where: 'frontmatter · spawned',
          }),
        );
      }
    }
    return findings;
  },
  title: 'Seed field + reference validity',
};

/**
 * Task `upstream` references (MMR-244, severities revised MMR-245): a task whose
 * `upstream` seed pointer is malformed grammar (not a `KEY-sN`) or dangles
 * (resolves to no surviving seed). The two differ in what a reader drops, so the
 * severity now tracks that truthfully (annotation #2):
 * - MALFORMED is nulled on read — the reader's local decode drops it, like a
 *   foreign priority — so it is an `error` (the reader drops it).
 * - DANGLING but well-formed is NOT dropped by any reader: the hot path loads no
 *   seeds, and the verb surface only grammar-validates `--upstream` (a task→seed
 *   reference is intentionally reference-only, ADR 0020) — so it is a `warn`,
 *   surfaced for repair, not lost.
 * A thin adapter over the shared validator's two `*-upstream` rules; whole-vault.
 */
export const upstreamRefCheck: Diagnostic = {
  name: 'upstream-refs',
  run: (ctx) => {
    const findings: DoctorFinding[] = [];
    for (const drop of ctx.dropped) {
      if (!ownsDrop(drop, 'upstream-refs') || drop.kind !== 'field') {
        continue;
      }
      const malformed = drop.rule === 'malformed-upstream';
      findings.push(
        issue({
          check: 'upstream-refs',
          code: drop.rule,
          evidence: { value: drop.value },
          message: malformed
            ? `upstream "${drop.value}" is not a seed id (KEY-sN) — field nulled on read`
            : `upstream ${drop.value} resolves to no seed in the vault — surfaced for repair; the reference is reference-only (not dropped on read)`,
          node: drop.stem,
          severity: malformed ? 'error' : 'warn',
          where: 'frontmatter · upstream',
        }),
      );
    }
    return findings;
  },
  title: 'Task → seed (upstream) references',
};

/** The registered checks `mimir doctor` runs, in report order. */
export const CHECKS: readonly Diagnostic[] = [
  bodySectionCheck,
  crlfCheck,
  identityUniquenessCheck,
  danglingRefCheck,
  missingProjectCheck,
  acyclicityCheck,
  fieldValidityCheck,
  seedValidityCheck,
  upstreamRefCheck,
  frontmatterCheck,
  stemProjectCheck,
  sectionResolutionCheck,
  seqGapCheck,
];
