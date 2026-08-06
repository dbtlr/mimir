/**
 * Vault data migrations — the doc-content backfills a schema bump needs, the
 * counterpart to {@link ./converge}'s structural upgrade (marker + rules). A
 * structural bump alone leaves existing documents in the old shape; these
 * rewrite them forward through Norn (ADR 0018: vault access is Norn-only), so an
 * upgraded vault is not merely *declared* current but actually is.
 *
 * Injected into `converge` as `migrateData` and run BEFORE the marker bump, so a
 * crash mid-backfill leaves the marker at the old schema and the next converge
 * retries. Every backfill is idempotent (it targets only the docs still missing
 * the change), so a resumed run completes the remainder.
 */
import { parseIdentity, wikilink } from '../core/ids';
import { journalTimestamps } from '../core/scratchpads/codec';
import { applyReportOutcome } from '../core/store-norn/apply-report';
import { NornClient } from '../core/store-norn/client';
import { stemOf } from '../core/store-norn/decode';
import type { MigrationOp } from '../core/store-norn/plan';
import { migrationPlan, replaceBody, setFrontmatter } from '../core/store-norn/plan';
import { canonicalInstant, isCanonicalInstant, TIMESTAMP_FIELDS } from '../core/time';

/** The vault schema that introduced the `project` frontmatter field (MMR-170). */
const PROJECT_FIELD_SCHEMA = 3;

/** The vault schema that made the canonical instant a persisted invariant (MMR-351). */
const CANONICAL_TIMESTAMP_SCHEMA = 9;
const JOURNAL_TIMESTAMP_SCHEMA = 10;

const WORK_STATE_TYPES = 'type:project,task,phase,initiative';

/** Every document kind that stores an instant — the whole vault, by type. */
const TIMESTAMPED_TYPES = 'type:project,task,phase,initiative,seed,artifact,scratch';

/**
 * Backfill the `project` frontmatter field (MMR-170) onto work-state documents
 * that predate it. The project key comes from the document's **stem** — the
 * `KEY`/`KEY-seq` identity, parsed with {@link parseIdentity} — never from its
 * directory: the `KEY/…` path layout is deliberately irrelevant to identity, so
 * the stem is the sole source. The field is written as a wikilink to the project
 * document, exactly what `nodeFrontmatter`/`projectFrontmatter` emit. Idempotent
 * — it targets only documents actually missing the field (`--missing project`) —
 * so a re-run after a partial write completes the rest. Returns the changed
 * paths.
 */
export async function backfillProjectField(client: NornClient): Promise<string[]> {
  const docs = await client.find({ in: [WORK_STATE_TYPES], missing: ['project'], no_limit: true });
  const changed: string[] = [];
  for (const doc of docs) {
    const stem = stemOf(doc.path);
    const key = parseIdentity(stem)?.key;
    if (key === undefined) {
      continue; // an unparseable stem — leave it for doctor to surface
    }
    // Address the document by its STEM, never its path — the stem resolves
    // cleanly and the `KEY/…` layout is deliberately irrelevant. `confirm: true`
    // applies the write (an unconfirmed `set` is a preview).
    await client.set({ confirm: true, set: { project: wikilink(key) }, target: stem });
    changed.push(doc.path);
  }
  return changed;
}

/**
 * Normalize every stored instant that is merely a VARIANT of the canonical form
 * (MMR-351, ADR 0029) — an offset zone, an absent millisecond, extra precision.
 * Norn's `datetime` type accepts all of them, but lexical comparison (which the
 * query paths, the annotation sort, and the transition cursor all rely on) does
 * not, so a variant compares wrongly against every canonical stamp beside it.
 *
 * It never guesses. A zone-less or malformed value states no instant, so it is
 * left EXACTLY as written and reported by `doctor` as corruption requiring an
 * explicit correction: a migration that picked UTC (or the host's zone) would
 * bake a silently wrong timestamp in forever, and a migration that FAILED on one
 * would strand the whole vault at the old schema. Body record headings are
 * likewise untouched here — `doctor --fix` repairs those under a whole-document
 * CAS, which a rules-and-marker upgrade has no business doing unattended.
 *
 * Idempotent: it targets only values that are not already canonical, so a re-run
 * after a partial write completes the rest. Returns the changed paths.
 */
export async function backfillCanonicalTimestamps(
  client: NornClient,
  vaultRoot: string,
): Promise<string[]> {
  const docs = await client.find({
    col: ['.frontmatter'],
    in: [TIMESTAMPED_TYPES],
    no_limit: true,
  });
  const operations: MigrationOp[] = [];
  const changed: string[] = [];
  for (const doc of docs) {
    const frontmatter = doc.frontmatter ?? {};
    let touched = false;
    for (const field of TIMESTAMP_FIELDS) {
      const raw = frontmatter[field];
      if (raw === undefined || raw === null || isCanonicalInstant(raw)) {
        continue;
      }
      const canonical = canonicalInstant(raw);
      if (canonical === null) {
        continue; // no stated instant — doctor's to surface, never this migration's to invent
      }
      // Addressed by PATH (a scratchpad's stem is a UUID, not a resolvable
      // identity) and CAS-guarded on the value just read — norn reads an OMITTED
      // `expected_old_value` as "expected absent" and refuses, so the observed
      // value is what makes the write land. A genuine mismatch means someone
      // else wrote mid-upgrade: refusing leaves the marker at the old schema and
      // the next converge retries, which is the crash-safe ordering already.
      operations.push(setFrontmatter(doc.path, field, canonical, raw));
      touched = true;
    }
    if (touched) {
      changed.push(doc.path);
    }
  }
  if (operations.length === 0) {
    return [];
  }
  const outcome = applyReportOutcome(
    await client.applyPlan(
      migrationPlan({ generator: 'mimir-converge', operations, vaultRoot }),
      true,
    ),
  );
  if (outcome !== 'applied') {
    throw new Error(
      `the canonical-timestamp backfill did not apply (outcome: ${outcome ?? 'unrecognized'})`,
    );
  }
  return changed;
}

/** Normalize recoverable Scratchpad Journal headings under whole-document CAS. */
export async function backfillJournalTimestamps(
  client: NornClient,
  vaultRoot: string,
): Promise<string[]> {
  const docs = await client.find({
    col: ['.body', '.document_hash'],
    in: ['type:scratch'],
    no_limit: true,
  });
  const operations: MigrationOp[] = [];
  const changed: string[] = [];
  for (const doc of docs) {
    if (typeof doc.body !== 'string' || typeof doc.document_hash !== 'string') {
      continue;
    }
    const lines = doc.body.split('\n');
    let touched = false;
    for (const record of journalTimestamps(doc.body)) {
      const canonical = canonicalInstant(record.value);
      if (canonical === null || canonical === record.value) {
        continue;
      }
      const line = lines[record.line - 1];
      if (line === undefined) {
        continue;
      }
      lines[record.line - 1] = line.replace(` — ${record.value}`, ` — ${canonical}`);
      touched = true;
    }
    if (touched) {
      operations.push(replaceBody(doc.path, doc.document_hash, lines.join('\n')));
      changed.push(doc.path);
    }
  }
  if (operations.length === 0) {
    return [];
  }
  const outcome = applyReportOutcome(
    await client.applyPlan(
      migrationPlan({ generator: 'mimir-converge', operations, vaultRoot }),
      true,
    ),
  );
  if (outcome !== 'applied') {
    throw new Error(
      `the Journal timestamp backfill did not apply (outcome: ${outcome ?? 'unrecognized'})`,
    );
  }
  return changed;
}

/**
 * `converge`'s `migrateData` hook: run every data migration an upgrade from
 * `fromSchema` needs, over a transient client at `path`. Returns the changed
 * document paths for converge to stage. A no-op (no client spawned) when the
 * vault is already at or past every migration's target schema.
 */
export async function backfillVaultData(path: string, fromSchema: number): Promise<string[]> {
  if (fromSchema >= JOURNAL_TIMESTAMP_SCHEMA) {
    return [];
  }
  const client = new NornClient({ vaultPath: path });
  try {
    const changed: string[] = [];
    if (fromSchema < PROJECT_FIELD_SCHEMA) {
      changed.push(...(await backfillProjectField(client)));
    }
    if (fromSchema < CANONICAL_TIMESTAMP_SCHEMA) {
      changed.push(...(await backfillCanonicalTimestamps(client, path)));
    }
    changed.push(...(await backfillJournalTimestamps(client, path)));
    return [...new Set(changed)];
  } finally {
    await client.close();
  }
}
