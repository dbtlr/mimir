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
import { parseId } from '../core/ids';
import type { NodeRefs } from '../core/store-norn';

/** What a check reads: the raw vault documents to diagnose. */
export type DoctorContext = {
  /** Every work-state document's raw markdown, as `{ stem, body }` — scoped by `-s`. */
  readNodeDocs: () => Promise<{ stem: string; body: string }[]>;
  /** Every node's raw, unresolved parent/depends_on stems — always whole-vault
   * (the dangling-ref failure is global, not scoped). */
  readNodeRefs: () => Promise<NodeRefs[]>;
};

/** One problem a check found, anchored for a human to locate and fix. */
export type DoctorFinding = {
  /** The reporting check's {@link Diagnostic.name}. */
  check: string;
  /** `error` fails the run (nonzero exit); `warn` is advisory. */
  severity: 'error' | 'warn';
  /** The offending node's `KEY-seq` stem. */
  node: string;
  /** Where in the document, e.g. `History · line 6`. */
  where: string;
  /** A one-line human description of the problem. */
  message: string;
};

/** A registered diagnostic: a named check over the vault. */
export type Diagnostic = {
  name: string;
  title: string;
  run: (ctx: DoctorContext) => Promise<DoctorFinding[]>;
};

/**
 * Per-problem severity + message. The read path (MMR-161) is deliberately
 * tolerant: an unescaped `### ` line that isn't a valid record boundary stays as
 * the enclosing record's content — preserved, not lost. So only a genuinely
 * *dropped* record is an `error` (a valid heading whose record the reader filters
 * out, losing the transition); a heading-shaped line the reader keeps as text is
 * a `warn` — it reads fine, but it looks like a record a hand edit may have meant.
 * Only `error` findings gate (nonzero exit), so a warn never blocks a cutover.
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
 * Dangling relational references (MMR-169): a node whose `parent` (a `KEY-seq`)
 * or `depends_on` stem resolves to no node in the vault. A dangling ref is one
 * cause of a vault that will not load — the Norn working-set loader throws on
 * the *first* such ref (`store-norn.ts`), so it names only one; doctor reads the
 * raw refs below it and enumerates them all. Always an `error` (the vault is
 * unreadable until fixed), and whole-vault: a single dangler breaks *every*
 * command regardless of `-s`, so the check ignores scope. A bare project `KEY`
 * parent is a root, not a reference — skipped, exactly as the loader treats it.
 * This check covers only unresolved parent/prerequisite stems; the loader's
 * other load-breakers are other checks' domains — a cycle (self-dependency
 * included) is the acyclicity check (MMR-174), a missing project or malformed
 * field is a structural check (MMR-177). It does not claim to catch them all.
 */
export const danglingRefCheck: Diagnostic = {
  name: 'dangling-refs',
  run: async (ctx) => {
    const refs = await ctx.readNodeRefs();
    // `readNodeRefs` already yields only valid `KEY-seq` nodes (the loader's
    // `rawNodes` partition), so their stems ARE the loader's `nodeIdByStem` —
    // the exact set a parent/prerequisite must resolve into.
    const nodeStems = new Set(refs.map((r) => r.stem));
    const findings: DoctorFinding[] = [];
    for (const { stem, parent, dependsOn } of refs) {
      if (parent !== null && parseId(parent) !== null && !nodeStems.has(parent)) {
        findings.push({
          check: 'dangling-refs',
          message: `parent ${parent} resolves to no node in the vault — the vault will not load`,
          node: stem,
          severity: 'error',
          where: 'frontmatter · parent',
        });
      }
      for (const dep of dependsOn) {
        if (!nodeStems.has(dep)) {
          findings.push({
            check: 'dangling-refs',
            message: `depends_on ${dep} resolves to no node in the vault — the vault will not load`,
            node: stem,
            severity: 'error',
            where: 'frontmatter · depends_on',
          });
        }
      }
    }
    return findings;
  },
  title: 'Dangling relational references',
};

/** The registered checks `mimir doctor` runs, in report order. */
export const CHECKS: readonly Diagnostic[] = [bodySectionCheck, danglingRefCheck];
