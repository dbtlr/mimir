import { fromMarkdown } from 'mdast-util-from-markdown';

import { renderHistoryBody, renderHistoryRecord, toCanonicalLf } from '../core/history-codec';
import { parseIdentity, wikilink } from '../core/ids';
import type { Project } from '../core/model';
import type { MigrationOp, MigrationPlan } from '../core/store-norn/plan';
import {
  addFrontmatter,
  createDocument,
  migrationPlan,
  replaceBody,
  setFrontmatter,
} from '../core/store-norn/plan';
import { projectFrontmatter } from '../core/vault-frontmatter';
import type { DoctorFinding, DoctorIssueCode } from './checks';
import type { DoctorSnapshot, DoctorSnapshotDocument } from './snapshot';
import { doctorIdentityIndex, doctorLogicalStemAtPath } from './snapshot';

export type RepairRecipe =
  | 'add-canonical-heading'
  | 'normalize-crlf'
  | 'recover-missing-project'
  | 'restore-project-projection'
  | 'stamp-updated-at';

export type RepairSkipReason =
  | 'ambiguous-body-record'
  | 'ambiguous-identity'
  | 'ambiguous-section-heading'
  | 'canonical-path-occupied'
  | 'invalid-semantic-value'
  | 'non-corruption-warning'
  | 'out-of-scope'
  | 'semantic-reference'
  | 'unreadable-document';

export type RepairPolicy =
  | { kind: 'supported'; recipe: RepairRecipe }
  | { kind: 'skipped'; reason: RepairSkipReason };

/** Total repair disposition for every stable diagnostic code. Because the code
 * union includes Drop['rule'], adding a validator rule cannot compile until it
 * is explicitly supported or skipped here. */
export const REPAIR_POLICY: Record<DoctorIssueCode, RepairPolicy> = {
  'archived-requester': { kind: 'skipped', reason: 'non-corruption-warning' },
  'crlf-body': { kind: 'supported', recipe: 'normalize-crlf' },
  'cycle-depends-on': { kind: 'skipped', reason: 'semantic-reference' },
  'cycle-parent': { kind: 'skipped', reason: 'semantic-reference' },
  'dangling-depends-on': { kind: 'skipped', reason: 'semantic-reference' },
  'dangling-parent': { kind: 'skipped', reason: 'semantic-reference' },
  'dangling-spawned': { kind: 'skipped', reason: 'semantic-reference' },
  'dangling-upstream': { kind: 'skipped', reason: 'semantic-reference' },
  // A duplicate artifact stem is two distinct documents claiming one id — which
  // survives is a human call, never a doctor mutation (ADR 0023: detect, don't
  // guard). `--fix` skips it, exactly like the work-state `duplicate-stem` (MMR-282).
  'duplicate-artifact-stem': { kind: 'skipped', reason: 'ambiguous-identity' },
  'duplicate-stem': { kind: 'skipped', reason: 'ambiguous-identity' },
  'frontmatter-disallowed-value': { kind: 'skipped', reason: 'unreadable-document' },
  'frontmatter-parse-failed': { kind: 'skipped', reason: 'unreadable-document' },
  'frontmatter-required-field-missing': { kind: 'skipped', reason: 'unreadable-document' },
  // A seq gap is deletion evidence, not repairable structure: `--fix` must not
  // touch it (recovery is `git revert`, ADR 0017). Informational, like the other
  // non-corruption warning (`archived-requester`).
  'interior-seq-gap': { kind: 'skipped', reason: 'non-corruption-warning' },
  'invalid-hold': { kind: 'skipped', reason: 'invalid-semantic-value' },
  'invalid-lifecycle': { kind: 'skipped', reason: 'invalid-semantic-value' },
  'invalid-open-ended': { kind: 'skipped', reason: 'invalid-semantic-value' },
  'invalid-priority': { kind: 'skipped', reason: 'invalid-semantic-value' },
  'invalid-seed-kind': { kind: 'skipped', reason: 'invalid-semantic-value' },
  'invalid-seed-lifecycle': { kind: 'skipped', reason: 'invalid-semantic-value' },
  'invalid-size': { kind: 'skipped', reason: 'invalid-semantic-value' },
  'malformed-history-heading': { kind: 'skipped', reason: 'ambiguous-body-record' },
  'malformed-upstream': { kind: 'skipped', reason: 'invalid-semantic-value' },
  'missing-project': { kind: 'supported', recipe: 'recover-missing-project' },
  'missing-updated-at': { kind: 'supported', recipe: 'stamp-updated-at' },
  'non-iso-annotation-heading': { kind: 'skipped', reason: 'ambiguous-body-record' },
  'orphaned-seed': { kind: 'supported', recipe: 'recover-missing-project' },
  'section-annotations-unreadable': {
    kind: 'supported',
    recipe: 'add-canonical-heading',
  },
  'section-history-unreadable': { kind: 'supported', recipe: 'add-canonical-heading' },
  'stem-project-divergence': { kind: 'supported', recipe: 'restore-project-projection' },
  'unknown-requester': { kind: 'skipped', reason: 'semantic-reference' },
  'unknown-transition-kind': { kind: 'skipped', reason: 'ambiguous-body-record' },
  'unparseable-history-record': { kind: 'skipped', reason: 'ambiguous-body-record' },
  'value-not-allowed': { kind: 'skipped', reason: 'unreadable-document' },
};

export type RepairItem = {
  issue: DoctorFinding;
  recipe?: RepairRecipe;
  reason?: RepairSkipReason;
};

export type RepairPlanningFailure = {
  issue: DoctorFinding;
  reason: 'missing-cas-hash' | 'missing-snapshot-document' | 'missing-snapshot-value';
};

export type DoctorRepairPlan = {
  failures: RepairPlanningFailure[];
  migration: MigrationPlan;
  planned: RepairItem[];
  skipped: RepairItem[];
};

function issueInScope(issue: DoctorFinding, scope: string | undefined): boolean {
  return scope === undefined || issue.scopeKey === scope;
}

type StructuralHeading = { name: string; start: number };

type MarkdownNode = {
  alt?: string | null;
  children?: readonly MarkdownNode[];
  position?: { start: { offset?: number } };
  type: string;
  value?: string;
};

/** Norn's resolver names headings from text/code events; HTML markup itself does
 * not contribute to the name, while its textual children still do. */
function resolverHeadingName(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value ?? '';
  }
  if (node.type === 'image' || node.type === 'imageReference') {
    return resolverHeadingName(fromMarkdown(node.alt ?? ''));
  }
  return (node.children ?? []).map(resolverHeadingName).join('');
}

function trimRustWhitespace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

/** Parse every CommonMark heading node so nesting, depth, fences, and inline
 * formatting have the same structural meaning as the section resolver. */
function structuralHeadings(body: string): StructuralHeading[] {
  const headings: StructuralHeading[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type !== 'heading') {
      for (const child of node.children ?? []) {
        visit(child);
      }
      return;
    }
    const start = node.position?.start.offset;
    if (start !== undefined) {
      headings.push({ name: trimRustWhitespace(resolverHeadingName(node)), start });
    }
  };
  visit(fromMarkdown(body));
  return headings;
}

function lineStart(body: string, offset: number): number {
  const before = Math.max(0, offset - 1);
  return Math.max(body.lastIndexOf('\n', before), body.lastIndexOf('\r', before)) + 1;
}

function appendCanonicalHeading(body: string, heading: string): string {
  const base = body.endsWith('\r') ? `${body.slice(0, -1)}\n` : body;
  if (heading === 'History') {
    const annotations = structuralHeadings(base).find(({ name }) => name === 'Annotations');
    if (annotations !== undefined) {
      const insertion = lineStart(base, annotations.start);
      return `${base.slice(0, insertion)}## History\n${base.slice(insertion)}`;
    }
  }
  const separator = base.length === 0 || base.endsWith('\n') ? '' : '\n';
  return `${base}${separator}## ${heading}\n`;
}

function occupiedPaths(snapshot: DoctorSnapshot): ReadonlySet<string> {
  return new Set([
    ...snapshot.documents.map((doc) => doc.path),
    ...snapshot.validateFindings.map((finding) => finding.path),
  ]);
}

function recoveryOperation(key: string, timestamp: string): MigrationOp {
  const reason = `Recovered by mimir doctor --fix because project ${key} was missing.`;
  const recovered: Project = {
    archived_at: timestamp,
    created_at: timestamp,
    description: null,
    key,
    name: `Recovered ${key}`,
    updated_at: timestamp,
  };
  return createDocument(
    `${key}/${key}.md`,
    projectFrontmatter(recovered, []),
    `${renderHistoryBody()}${renderHistoryRecord({
      at: timestamp,
      from: 'active',
      kind: 'archive',
      reason,
      to: 'archived',
    })}`,
  );
}

type BodyRepair = {
  body: string;
  doc: DoctorSnapshotDocument;
  issues: RepairItem[];
};

/** Pure one-snapshot planner. It never redetects diagnostic classes: it
 * classifies the supplied structured issues, using snapshot bytes only for CAS
 * values and the section recipe's required zero-resolver-equivalent-heading proof. */
export function planDoctorRepairs(args: {
  issues: readonly DoctorFinding[];
  scope: string | undefined;
  snapshot: DoctorSnapshot;
  timestamp: string;
  vaultRoot: string;
}): DoctorRepairPlan {
  const failures: RepairPlanningFailure[] = [];
  const operations: MigrationOp[] = [];
  const planned: RepairItem[] = [];
  const skipped: RepairItem[] = [];
  const docsByStem = new Map<string, DoctorSnapshotDocument[]>();
  const docsByPath = new Map<string, DoctorSnapshotDocument[]>();
  for (const doc of args.snapshot.documents) {
    docsByStem.set(doc.stem, [...(docsByStem.get(doc.stem) ?? []), doc]);
    docsByPath.set(doc.path, [...(docsByPath.get(doc.path) ?? []), doc]);
  }
  const bodies = new Map<string, BodyRepair>();
  const occupied = occupiedPaths(args.snapshot);
  const identityIndex = doctorIdentityIndex(args.snapshot);
  const physicalPathsByStem = identityIndex.pathsByStem;
  const recovered = new Set<string>();

  const selected = args.issues.toSorted((a, b) =>
    `${a.scopeKey}\0${a.stem}\0${a.code}`.localeCompare(
      `${b.scopeKey}\0${b.stem}\0${b.code}`,
      undefined,
      { numeric: true },
    ),
  );

  for (const entry of selected) {
    if (!issueInScope(entry, args.scope)) {
      skipped.push({ issue: entry, reason: 'out-of-scope' });
      continue;
    }
    const policy = REPAIR_POLICY[entry.code];
    if (policy.kind === 'skipped') {
      skipped.push({ issue: entry, reason: policy.reason });
      continue;
    }

    if (policy.recipe === 'recover-missing-project') {
      const key = typeof entry.evidence.key === 'string' ? entry.evidence.key : entry.scopeKey;
      const path = `${key}/${key}.md`;
      if (occupied.has(path)) {
        skipped.push({ issue: entry, reason: 'canonical-path-occupied' });
        continue;
      }
      if ((physicalPathsByStem.get(key)?.size ?? 0) > 0) {
        skipped.push({ issue: entry, reason: 'ambiguous-identity' });
        continue;
      }
      if (!recovered.has(key)) {
        operations.push(recoveryOperation(key, args.timestamp));
        recovered.add(key);
      }
      planned.push({ issue: entry, recipe: policy.recipe });
      continue;
    }

    const exactDocs = docsByPath.get(entry.locator) ?? [];
    const matchingDocs = exactDocs.length > 0 ? exactDocs : (docsByStem.get(entry.stem) ?? []);
    if (matchingDocs.length === 0) {
      failures.push({ issue: entry, reason: 'missing-snapshot-document' });
      continue;
    }
    if (
      matchingDocs.length !== 1 ||
      (docsByPath.get(matchingDocs[0]?.path ?? '')?.length ?? 0) !== 1
    ) {
      skipped.push({ issue: entry, reason: 'ambiguous-identity' });
      continue;
    }
    const doc = matchingDocs[0];
    if (doc === undefined) {
      failures.push({ issue: entry, reason: 'missing-snapshot-document' });
      continue;
    }
    const logicalStem = doctorLogicalStemAtPath(identityIndex, doc.path) ?? entry.stem;
    if (physicalPathsByStem.get(logicalStem)?.size !== 1) {
      skipped.push({ issue: entry, reason: 'ambiguous-identity' });
      continue;
    }

    if (policy.recipe === 'restore-project-projection') {
      const expected = doc.frontmatter?.project;
      if (expected === undefined) {
        failures.push({ issue: entry, reason: 'missing-snapshot-value' });
        continue;
      }
      const projectKey = parseIdentity(logicalStem)?.key ?? entry.scopeKey;
      operations.push(setFrontmatter(doc.path, 'project', wikilink(projectKey), expected));
      planned.push({ issue: entry, recipe: policy.recipe });
      continue;
    }

    if (policy.recipe === 'stamp-updated-at') {
      // Trusts the finding's own classification (never redetects) — `present`
      // says whether `updated_at` sat in frontmatter with a null value or was
      // absent entirely; snapshot bytes are read only for the CAS stamp value
      // (`created`, when the document carries one). This is the one recipe whose
      // write cannot itself carry an `updated_at` CAS guard — the field is
      // absent/null, exactly the condition the finding names — so it is planned
      // as an `add_frontmatter` (absent) or a `set_frontmatter` asserting the
      // null old value (present-but-null), never a value-guarded `set_frontmatter`.
      const present = entry.evidence.present === true;
      const created = doc.frontmatter?.created;
      const stamp = typeof created === 'string' && created !== '' ? created : args.timestamp;
      operations.push(
        present
          ? setFrontmatter(doc.path, 'updated_at', stamp, null)
          : addFrontmatter(doc.path, 'updated_at', stamp),
      );
      planned.push({ issue: entry, recipe: policy.recipe });
      continue;
    }

    let bodyRepair = bodies.get(doc.path);
    if (bodyRepair === undefined) {
      bodyRepair = { body: doc.body, doc, issues: [] };
      bodies.set(doc.path, bodyRepair);
    }
    if (policy.recipe === 'normalize-crlf') {
      bodyRepair.body = toCanonicalLf(bodyRepair.body);
      bodyRepair.issues.push({ issue: entry, recipe: policy.recipe });
      continue;
    }
    const section = entry.code === 'section-history-unreadable' ? 'History' : 'Annotations';
    if (structuralHeadings(bodyRepair.body).some(({ name }) => name === section)) {
      skipped.push({ issue: entry, reason: 'ambiguous-section-heading' });
      continue;
    }
    const repairedBody = appendCanonicalHeading(bodyRepair.body, section);
    const repairedHeadings = structuralHeadings(repairedBody).filter(
      ({ name }) => name === section,
    );
    if (repairedHeadings.length !== 1) {
      skipped.push({ issue: entry, reason: 'ambiguous-section-heading' });
      continue;
    }
    bodyRepair.body = repairedBody;
    bodyRepair.issues.push({ issue: entry, recipe: policy.recipe });
  }

  for (const bodyRepair of [...bodies.values()].toSorted((a, b) =>
    a.doc.path.localeCompare(b.doc.path),
  )) {
    if (bodyRepair.issues.length === 0 || bodyRepair.body === bodyRepair.doc.body) {
      continue;
    }
    if (bodyRepair.doc.documentHash === null) {
      failures.push(
        ...bodyRepair.issues.map(({ issue }) => ({
          issue,
          reason: 'missing-cas-hash' as const,
        })),
      );
      continue;
    }
    operations.push(replaceBody(bodyRepair.doc.path, bodyRepair.doc.documentHash, bodyRepair.body));
    planned.push(...bodyRepair.issues);
  }

  return {
    failures,
    migration: migrationPlan({ generator: 'mimir-doctor', operations, vaultRoot: args.vaultRoot }),
    planned,
    skipped,
  };
}

/** Stable identity used to reconcile a planned issue against post-image
 * diagnostics. A project projection follows its exact physical target even if a
 * concurrent key edit changes the finding's logical identity. */
export function repairIssueKey(issue: DoctorFinding): string {
  if (issue.code === 'missing-project' || issue.code === 'orphaned-seed') {
    const projectKey = typeof issue.evidence.key === 'string' ? issue.evidence.key : issue.scopeKey;
    return `${issue.code}\0${projectKey}`;
  }
  if (issue.code === 'stem-project-divergence') {
    return `${issue.code}\0${issue.locator}`;
  }
  return `${issue.code}\0${issue.scopeKey}\0${issue.stem}`;
}
