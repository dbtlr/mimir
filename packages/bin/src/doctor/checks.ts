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
import type { Drop } from '../core/validate';
import type { ValidateFinding } from '../norn/decode';
import { stemOf } from '../norn/decode';

/** What a check reads: the raw vault documents to diagnose. */
export type DoctorContext = {
  /** Every work-state document's raw markdown, as `{ stem, body }` — scoped by `-s`. */
  readNodeDocs: () => Promise<{ stem: string; body: string }[]>;
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
};

/** One problem a check found, anchored for a human to locate and fix. */
export type DoctorFinding = {
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
};

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
    for (const { stem, body } of await ctx.readNodeDocs()) {
      for (const f of lintBodySections(body)) {
        const { message, severity } = PROBLEM[f.problem];
        findings.push({
          check: 'body-sections',
          message: `${message} — ${f.heading}`,
          node: stem,
          severity,
          where: `${f.section} · line ${String(f.line)}`,
        });
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
    for (const { stem, body } of await ctx.readNodeDocs()) {
      const count = (body.match(/\r\n/g) ?? []).length;
      if (count > 0) {
        findings.push({
          check: 'crlf',
          message: `body uses CRLF line endings (${String(count)}) — tolerated on read (MMR-167) but non-canonical`,
          node: stem,
          severity: 'warn',
          where: 'body',
        });
      }
    }
    return findings;
  },
  title: 'CRLF line endings',
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
      // Only the dangling-* edge rules — a cycle edge (MMR-174) is a distinct rule
      // reported by {@link acyclicityCheck}, not a dangling reference.
      if (
        drop.kind !== 'edge' ||
        (drop.rule !== 'dangling-parent' && drop.rule !== 'dangling-depends-on')
      ) {
        continue;
      }
      const field = drop.rule === 'dangling-parent' ? 'parent' : 'depends_on';
      findings.push({
        check: 'dangling-refs',
        message: `${field} ${drop.ref} resolves to no node in the vault — the reference is dropped on read`,
        node: drop.stem,
        severity: 'error',
        where: `frontmatter · ${field}`,
      });
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
 * {@link danglingRefCheck} over the same `validate` pass: `error`,
 * whole-vault, vault-only (SQLite's `project_id` FK precludes it).
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
      if (drop.kind !== 'node' || drop.rule !== 'missing-project') {
        continue;
      }
      const seen = missing.get(drop.key);
      if (seen === undefined) {
        missing.set(drop.key, { count: 1, node: drop.stem });
      } else {
        seen.count += 1;
      }
    }
    return Array.from(missing, ([key, { node, count }]) => ({
      check: 'missing-project',
      message: `project ${key} has no document in the vault (referenced by ${String(count)} node${count === 1 ? '' : 's'}) — its nodes are hidden on read`,
      node,
      severity: 'error',
      where: 'project',
    }));
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
      if (
        drop.kind !== 'edge' ||
        (drop.rule !== 'cycle-parent' && drop.rule !== 'cycle-depends-on')
      ) {
        continue;
      }
      const field = drop.rule === 'cycle-parent' ? 'parent' : 'depends_on';
      findings.push({
        check: 'acyclicity',
        message: `${field} ${drop.ref} closes a cycle — the edge is dropped on read`,
        node: drop.stem,
        severity: 'error',
        where: `frontmatter · ${field}`,
      });
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
        // A referential drop (missing-project / dangling / cycle) — reported by the
        // referential checks, not here. Exactly one check renders each rule.
        continue;
      }
      findings.push({
        check: 'field-validity',
        message,
        node: drop.stem,
        severity: 'error',
        where: `frontmatter · ${field}`,
      });
    }
    return findings;
  },
  title: 'Node field validity',
};

/**
 * A finding's `path` names a work-state document — and its stem — iff the path
 * matches one of the vault's three parent-dir-anchored layouts (the
 * `allowed_paths` in `vault/schema.ts`): a node `KEY/KEY-seq.md`, a project
 * `KEY/KEY.md`, or an artifact `KEY/artifacts/KEY-aN.md`. Every reader (and every
 * other doctor check) enumerates the vault by `type:`, so a doc whose frontmatter
 * won't parse or has no `type` is invisible to them and reported by norn's schema
 * pass by *path* only. The vault may hold unrelated docs (loose notes, a stray
 * `refs/AB-1.md`), so the anchoring is what keeps the check to real work-state
 * docs — a matching stem in the wrong directory is not one.
 */
function workStateStem(path: string): string | null {
  const stem = stemOf(path);
  const parts = path.split('/');
  const parent = parts.at(-2);
  const grandparent = parts.at(-3);
  const identity = parseIdentity(stem);
  // A node `KEY/KEY-seq.md`: the parent dir is the node's own project key.
  if (identity?.kind === 'node' && parent === identity.key) {
    return stem;
  }
  // A project `KEY/KEY.md`: the parent dir is that same key.
  if (identity?.kind === 'project' && parent === stem) {
    return stem;
  }
  // An artifact `KEY/artifacts/KEY-aN.md`: parent dir `artifacts`, grandparent
  // the artifact's project key. Artifacts are work-state docs too — a corrupt one
  // is invisible on read, so it belongs here (the finding's node is the KEY-aN).
  if (identity?.kind === 'artifact' && parent === 'artifacts' && grandparent === identity.key) {
    return stem;
  }
  return null;
}

/**
 * The frontmatter codes this check renders, and how to describe each. These three
 * code strings and the `field === "type"` gate on the two field-scoped ones are
 * the empirically-verified norn 0.44 `vault.validate` contract (mimir's generated
 * `.norn/config.yaml` carries the `document-type` rule): a corrupt work-state doc
 * emits `frontmatter-parse-failed` (no field — always qualifies) and, for a
 * missing/foreign type, `frontmatter-required-field-missing`/
 * `frontmatter-disallowed-value` with `field: "type"`. The two field-scoped codes
 * also fire for other fields (a missing `title`, a foreign `lifecycle`, …), which
 * leave the doc visible — hence the `field` gate. A future norn code rename lands
 * here.
 */
const FRONTMATTER: Record<string, { field: string | null; where: string; message: string }> = {
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
      byStem.set(stem, {
        check: 'frontmatter',
        message,
        node: stem,
        severity: 'error',
        where: spec.where,
      });
    }
    return [...byStem.values()];
  },
  title: 'Frontmatter parse-failed + untyped documents',
};

/** The registered checks `mimir doctor` runs, in report order. */
export const CHECKS: readonly Diagnostic[] = [
  bodySectionCheck,
  crlfCheck,
  danglingRefCheck,
  missingProjectCheck,
  acyclicityCheck,
  fieldValidityCheck,
  frontmatterCheck,
];
