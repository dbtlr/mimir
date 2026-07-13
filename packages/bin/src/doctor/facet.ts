/**
 * The `/api/doctor` record-health facet (MMR-185) — the console projection of the
 * SAME diagnostics `mimir doctor` renders (ADR 0017: one shared validator, two
 * views). The CLI prints {@link DoctorFinding}s; this facet enriches each finding
 * with what the Record-health panel needs — the offending document's path, the
 * offending frontmatter field's line + byte location, a source snippet with the
 * offending token marked, a nearest-legal suggestion over the closed vocabulary,
 * and file groups with dropped/readable counts. Read-only: it locates corruption
 * for a human to fix in the file; it never writes (ADR 0018 — every vault read is
 * a Norn read, here the `.raw` disk representation).
 *
 * The enrichment reads each affected document's `.raw` text (frontmatter + body,
 * fetched by path so it resolves even for a doc whose frontmatter won't parse) and
 * locates the field the finding names in {@link DoctorFinding.where}. The base
 * findings come from the one detector — {@link CHECKS} over the shared
 * `validate` — so the facet can never drift from what the reader drops or the CLI
 * reports; it is purely a richer presentation of the same truth.
 */
import {
  HOLD_VALUES,
  LIFECYCLE_VALUES,
  NODE_TYPE_VALUES,
  PRIORITY_VALUES,
  SEED_KIND_VALUES,
  SIZE_VALUES,
} from '@mimir/contract';

import { parseIdentity } from '../core/ids';
import type { DoctorFinding } from './checks';

/** One line of a source snippet; `offending` marks the bad token's span (0-based
 * column into `text`) when this is the offending line. */
export type SnippetLine = {
  n: number;
  text: string;
  offending?: { start: number; length: number };
};

/** One dropped record, enriched for the Record-health panel. Every locate-derived
 * field is nullable — a finding whose document can't be read (or whose field can't
 * be located) still renders its cause, path, and severity, degrading gracefully. */
export type DoctorRecord = {
  /** The offending document's `KEY-seq` stem — the record identity. */
  id: string;
  /** The plain-language cause chip: `illegal status word`, `malformed frontmatter`, … */
  cause: string;
  /** The finding's informational triage label (ADR 0017) — never a gate. */
  severity: DoctorFinding['severity'];
  /** The document's `title` frontmatter (the "what it was"), or null when unreadable. */
  title: string | null;
  /** The document's vault-relative path (`KEY/KEY-seq.md`). */
  path: string;
  /** The offending frontmatter field, when the cause is field-scoped. */
  field: string | null;
  /** The offending value verbatim, when located. */
  value: string | null;
  /** Line (1-based) + byte offset of the offending line within the document. */
  location: { line: number; byte: number } | null;
  /** A few context lines around the offending line, the bad token marked. */
  snippet: { lines: SnippetLine[] } | null;
  /** The nearest legal word over the field's closed vocabulary (edit distance). */
  suggestion: string | null;
  /** A one-line plain-language explanation of the cause. */
  note: string;
};

/** A file group — the dropped records of one project, with its readable tally. */
export type DoctorGroup = {
  /** The owning project key. */
  project: string;
  /** The project's vault directory (the group's path label). */
  path: string;
  /** How many records dropped in this project. */
  dropped: number;
  /** How many of the project's documents read normally. */
  readable: number;
  records: DoctorRecord[];
};

/** The `/api/doctor` facet payload. `groups` is empty on a clean vault (the panel
 * then shows its zero state and all surfacing is absent). */
export type DoctorFacet = {
  /** When this scan ran — the panel derives "last scan Ns ago" from it. */
  scanned_at: string;
  /** Total dropped records across every group — the surfacing count. */
  dropped_total: number;
  groups: DoctorGroup[];
};

/** The document layout inverse of `checks.ts`'s `workStateStem`: a stem → its
 * vault-relative path. Returns null for a stem that names no work-state doc. */
export function pathOfStem(stem: string): string | null {
  const identity = parseIdentity(stem);
  if (identity === null) {
    return null;
  }
  if (identity.kind === 'artifact') {
    return `${identity.key}/artifacts/${stem}.md`;
  }
  if (identity.kind === 'seed') {
    return `${identity.key}/seeds/${stem}.md`;
  }
  // A node (`KEY/KEY-seq.md`) or a project (`KEY/KEY.md`): both sit directly under
  // the project directory, keyed by the stem.
  return `${identity.key}/${stem}.md`;
}

/** Levenshtein edit distance — the metric the nearest-legal suggestion minimizes
 * over the closed vocabulary (the common hand-edit typo, e.g. `praked` → `parked`). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const curr = Array.from({ length: cols }, (_, j) => (j === 0 ? i : 0));
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[cols - 1] ?? 0;
}

/** The nearest vocabulary member to `value` by edit distance, or null when the
 * value is empty, the vocabulary is, or nothing is a NEAR miss. The suggestion
 * exists for the hand-edit typo (`praked` → `parked`); an unconditional nearest
 * would confidently suggest a word for pure line noise. The threshold is half the
 * candidate's length: a genuine typo corrupts a minority of the intended word's
 * characters, while gibberish needs edits to most of the candidate — measuring
 * against the candidate (not the value) keeps a long garbage value from inflating
 * its own budget. Ties resolve to vocabulary order. */
export function nearest(value: string, vocab: readonly string[]): string | null {
  if (value === '' || vocab.length === 0) {
    return null;
  }
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of vocab) {
    const score = editDistance(value.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore && score * 2 <= candidate.length) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** The closed vocabulary a field's value should belong to, for the nearest-legal
 * suggestion. Null for a field with no closed vocabulary (a reference, a section). */
function vocabularyOf(field: string | null): readonly string[] | null {
  switch (field) {
    case 'lifecycle': {
      return LIFECYCLE_VALUES;
    }
    case 'hold': {
      return HOLD_VALUES;
    }
    case 'priority': {
      return PRIORITY_VALUES;
    }
    case 'size': {
      return SIZE_VALUES;
    }
    case 'type': {
      return NODE_TYPE_VALUES;
    }
    case 'kind': {
      return SEED_KIND_VALUES;
    }
    default: {
      return null;
    }
  }
}

/** The cause chip + one-line note for a finding, keyed off its check and the field
 * its `where` names. The panel's amber chip and plain-language line come from here. */
function causeOf(finding: DoctorFinding, field: string | null): { cause: string; note: string } {
  switch (finding.check) {
    case 'frontmatter': {
      if (field === 'type') {
        return {
          cause: 'foreign type',
          note: 'Not a document type — the file is invisible to the reader.',
        };
      }
      return {
        cause: 'malformed frontmatter',
        note: 'Frontmatter could not be parsed — one bad file never takes down its siblings.',
      };
    }
    case 'field-validity':
    case 'seed-validity': {
      if (field === 'lifecycle' || field === 'hold') {
        return { cause: 'illegal status word', note: 'Not a status word.' };
      }
      if (field === 'priority') {
        return { cause: 'illegal priority', note: 'Not a priority.' };
      }
      if (field === 'size') {
        return { cause: 'illegal size', note: 'Not a size.' };
      }
      if (field === 'kind') {
        return { cause: 'illegal kind', note: 'Not a seed kind.' };
      }
      if (field === 'open_ended') {
        return { cause: 'illegal flag', note: 'Not a boolean.' };
      }
      if (field === 'requester') {
        return { cause: 'unknown requester', note: 'Names no active project — nulled on read.' };
      }
      if (field === 'spawned') {
        // A seed's dangling spawned edge — the CLI's "resolves to no node in the
        // vault — pruned on read", not the record-level missing-project fallback.
        return {
          cause: 'dangling spawned',
          note: 'Resolves to no node in the vault — pruned on read.',
        };
      }
      return { cause: 'missing project', note: 'The owning project has no document.' };
    }
    case 'missing-project': {
      return { cause: 'missing project', note: 'The owning project has no document.' };
    }
    case 'dangling-refs': {
      return {
        cause: 'dangling reference',
        note: 'Points at no document — the edge is dropped on read.',
      };
    }
    case 'acyclicity': {
      return { cause: 'relational cycle', note: 'Closes a cycle — the edge is dropped on read.' };
    }
    case 'stem-project': {
      return { cause: 'misfiled project', note: 'The project field diverges from the stem.' };
    }
    case 'upstream-refs': {
      return { cause: 'dangling upstream', note: 'The seed reference does not resolve.' };
    }
    case 'body-sections': {
      return { cause: 'malformed record', note: 'A record heading the reader cannot parse.' };
    }
    case 'section-resolution': {
      return {
        cause: 'unreadable section',
        note: 'A duplicate or missing heading — the section reads empty.',
      };
    }
    case 'crlf': {
      return { cause: 'CRLF line endings', note: 'Tolerated on read, but non-canonical.' };
    }
    default: {
      return { cause: finding.check, note: finding.message };
    }
  }
}

/** Strip a matching pair of surrounding single or double quotes from a YAML scalar
 * (`'Board polish: hover states'` → `Board polish: hover states`); left as-is when
 * unquoted. Used for the displayed value + suggestion, not the snippet span. */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    (value.startsWith("'") || value.startsWith('"')) &&
    value.endsWith(value[0] ?? '')
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Byte offset of a character index into `text` (UTF-8) — the panel's `byte N`. */
function byteOffset(text: string, charIndex: number): number {
  return Buffer.byteLength(text.slice(0, charIndex), 'utf8');
}

/** The field a finding's `where` names, e.g. `frontmatter · lifecycle` → `lifecycle`;
 * `frontmatter` → null; `body · History` → null (a section, not a field). */
function fieldOf(where: string): string | null {
  const [head, tail] = where.split(' · ');
  if (head === 'frontmatter' && tail !== undefined && tail !== '') {
    return tail;
  }
  return null;
}

/** Locate a `key:` line in a document's raw text (frontmatter scan). Returns the
 * 1-based line, the value verbatim, and the value's column span for the token
 * highlight, or null when the key is absent. */
export function locateField(
  raw: string,
  field: string,
): { line: number; value: string; start: number; length: number } | null {
  const lines = raw.split('\n');
  const pattern = new RegExp(`^(\\s*${field}\\s*:\\s*)(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const match = pattern.exec(line);
    if (match) {
      const prefix = match[1] ?? '';
      const value = (match[2] ?? '').trim();
      const start = prefix.length;
      return { length: (match[2] ?? '').length, line: i + 1, start, value };
    }
  }
  return null;
}

/** Locate a `## Heading` section line in raw text — the anchor for a body-section
 * or section-resolution finding. Returns the 1-based line, or null when absent. */
function locateHeading(raw: string, heading: string): number | null {
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === `## ${heading}`) {
      return i + 1;
    }
  }
  return null;
}

/** Build up to two context lines above the offending line + the offending line
 * itself (the mock's 3-line well), marking the bad token when given. */
function snippetAround(
  raw: string,
  line: number,
  offending?: { start: number; length: number },
): { lines: SnippetLine[] } {
  const all = raw.split('\n');
  const start = Math.max(1, line - 2);
  const lines: SnippetLine[] = [];
  for (let n = start; n <= line; n++) {
    const text = all[n - 1] ?? '';
    lines.push(n === line && offending !== undefined ? { n, offending, text } : { n, text });
  }
  return { lines };
}

/** Enrich one base finding into a panel record using its document's raw text.
 * Locate-derived fields degrade to null when the field/heading can't be found. */
function toRecord(finding: DoctorFinding, raw: string | undefined): DoctorRecord {
  const field = fieldOf(finding.where);
  const { cause, note } = causeOf(finding, field);
  const path = finding.locator.endsWith('.md')
    ? finding.locator
    : (pathOfStem(finding.node) ?? finding.node);
  const titleRaw = raw === undefined ? undefined : locateField(raw, 'title')?.value;
  const title = titleRaw === undefined ? null : (unquote(titleRaw) ?? null);

  let value: string | null = null;
  let location: { line: number; byte: number } | null = null;
  let snippet: { lines: SnippetLine[] } | null = null;
  let suggestion: string | null = null;

  if (raw !== undefined && field !== null) {
    const found = locateField(raw, field);
    if (found !== null) {
      // Display + suggestion use the unquoted scalar; the snippet highlight keeps
      // the raw token span (quotes included) so it lines up with the source text.
      value = unquote(found.value);
      location = { byte: byteOffset(raw, lineStartIndex(raw, found.line)), line: found.line };
      const offending =
        found.value === '' ? undefined : { length: found.length, start: found.start };
      snippet = snippetAround(raw, found.line, offending);
      const vocab = vocabularyOf(field);
      if (vocab !== null && value !== '') {
        suggestion = nearest(value, vocab);
      }
    }
  } else if (raw !== undefined) {
    // A section-scoped (body · Heading) or bare-frontmatter finding: anchor on the
    // section heading when named, else the frontmatter start.
    const [head, tail] = finding.where.split(' · ');
    // `body · <Heading>` names the heading in the tail; a bare section name (e.g.
    // `History · line N` with no located field) names it in the head. `frontmatter`
    // has no heading — anchor at the top.
    let heading: string | undefined;
    if (head === 'body') {
      heading = tail;
    } else if (head !== 'frontmatter' && head !== '') {
      heading = head;
    }
    const line = heading === undefined || heading === '' ? 1 : (locateHeading(raw, heading) ?? 1);
    location = { byte: byteOffset(raw, lineStartIndex(raw, line)), line };
    snippet = snippetAround(raw, line);
  }

  return {
    cause,
    field,
    id: finding.node,
    location,
    note,
    path,
    severity: finding.severity,
    snippet,
    suggestion,
    title,
    value,
  };
}

/** Character index of the start of a 1-based line in `raw`. */
function lineStartIndex(raw: string, line: number): number {
  if (line <= 1) {
    return 0;
  }
  let index = 0;
  let seen = 1;
  while (seen < line) {
    const next = raw.indexOf('\n', index);
    if (next === -1) {
      return raw.length;
    }
    index = next + 1;
    seen++;
  }
  return index;
}

/**
 * Build the facet from the base findings + the affected documents' raw text +
 * the readable-doc stems. Pure: every vault read has already happened; this only
 * shapes and groups. Groups are keyed by project (the audit's "per-project list of
 * dropped records"); a project appears only when it has ≥1 dropped record. Readable
 * is the project's type-visible docs minus its distinct dropped stems.
 */
export function buildDoctorFacet(input: {
  findings: readonly DoctorFinding[];
  rawByStem: ReadonlyMap<string, string>;
  readableDocStems: readonly string[];
  scannedAt: string;
}): DoctorFacet {
  const { findings, rawByStem, readableDocStems, scannedAt } = input;

  const readableByProject = new Map<string, number>();
  for (const stem of readableDocStems) {
    const key = parseIdentity(stem)?.key;
    if (key !== undefined) {
      readableByProject.set(key, (readableByProject.get(key) ?? 0) + 1);
    }
  }
  const readableStems = new Set(readableDocStems);

  const groups = new Map<string, { records: DoctorRecord[]; droppedStems: Set<string> }>();
  for (const finding of findings) {
    const key = parseIdentity(finding.node)?.key ?? finding.node;
    let group = groups.get(key);
    if (group === undefined) {
      group = { droppedStems: new Set(), records: [] };
      groups.set(key, group);
    }
    group.records.push(
      toRecord(finding, rawByStem.get(finding.locator) ?? rawByStem.get(finding.node)),
    );
    group.droppedStems.add(finding.node);
  }

  const out: DoctorGroup[] = [];
  for (const [project, { records, droppedStems }] of groups) {
    // Readable = the project's type-visible docs, minus its dropped docs that WERE
    // type-visible (a foreign-type/parse-failed doc is not in the visible set, so it
    // never subtracts — it was already invisible).
    const visible = readableByProject.get(project) ?? 0;
    const droppedVisible = [...droppedStems].filter((s) => readableStems.has(s)).length;
    out.push({
      dropped: records.length,
      path: project,
      project,
      readable: Math.max(0, visible - droppedVisible),
      records,
    });
  }
  out.sort((a, b) => a.project.localeCompare(b.project));

  return {
    dropped_total: findings.length,
    groups: out,
    scanned_at: scannedAt,
  };
}
