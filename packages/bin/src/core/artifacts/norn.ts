import type { NornClient, NornDocument } from '../../norn/client';
import { collapse, isStringRecord, stringList } from '../../norn/decode';
import { createDocument, migrationPlan, SEQ_TOKEN } from '../../norn/plan';
import { invariant, validation } from '../errors';
import { parseIdentity, renderArtifactRef, wikilink } from '../ids';
import { now } from '../time';
import type { ArtifactCreate, ArtifactListQuery, ArtifactRecord, ArtifactStore } from './store';

/**
 * The Norn-vault `ArtifactStore` (MMR-143, ADR 0016 Phase 2a): an artifact is
 * a markdown document at `KEY/artifacts/KEY-aN.md` — the stem is the id,
 * frontmatter is the queryable record (`title`, `project` wikilink, `anchor`
 * wikilink list, `tags`, `created`), the body is the frozen content.
 *
 * - **Seq allocation rides the `{{seq}}` token** (MMR-196, ADR 0016 Refinement):
 *   a create is one `create_document` op whose path carries a trailing
 *   `KEY-a{{seq}}` token that Norn resolves to the next free sibling sequence
 *   at apply time — the same single allocation authority node creates use. There
 *   is no client-side `max(seq)+1` derivation and no create-exclusive retry: the
 *   apply report echoes the resolved `KEY-aN` stem, which is the artifact's
 *   canonical identity throughout the seam (ADR 0016).
 * - **Anchors may dangle during the split**: links are written as real
 *   wikilinks and queried as stored text (Norn collapses brackets in field
 *   matching) — ADR 0016 Refinement.
 * - **Tags are a plain set**: frontmatter `tags` are plain strings (ADR 0005);
 *   a tag application carries no note on any entity.
 * - **`q` search is case-insensitive and title-only** (in-process
 *   `toLowerCase().includes` over the loaded records); the title-only scope is
 *   the documented delta from the flag's prior title+content behavior.
 */

const stemOf = (key: string, seq: number): string => renderArtifactRef({ key, seq });
const pathOf = (key: string, seq: number): string => `${key}/artifacts/${stemOf(key, seq)}.md`;

/** The `create_document` path template for a fresh artifact — the trailing
 * `KEY-a{{seq}}` token is Norn's per-directory next-free allocation handle
 * (resolved at apply time), mirroring the node write path's `KEY-{{seq}}`. */
const createTemplate = (key: string): string => `${key}/artifacts/${key}-a${SEQ_TOKEN}.md`;

/**
 * The artifact frontmatter record handed to `create_document.new_value` — the
 * single write shape shared by `create` (which stamps `created=now()`) and the
 * cutover `restoreArtifact` (which preserves the source `created`). `anchor`
 * and `tags` are omitted when empty so an artifact carries only the fields it
 * has, matching the pre-seam markdown.
 */
function artifactFrontmatter(fields: {
  key: string;
  title: string;
  created: string;
  links: string[];
  tags: string[];
}): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    created: fields.created,
    project: wikilink(fields.key),
    title: fields.title,
    type: 'artifact',
  };
  if (fields.links.length > 0) {
    fm.anchor = fields.links.map(wikilink);
  }
  if (fields.tags.length > 0) {
    fm.tags = fields.tags;
  }
  return fm;
}

/**
 * The one `create_document` op line of a single-op apply report, paired with
 * norn's `outcome`. The local, minimal decode a create needs to read back the
 * resolved stem (or a destination-exists refusal for the idempotent restore) —
 * a shared/generalized apply-report decoder is the follow-up MMR-250, not this.
 */
function createReportOp(report: unknown): {
  outcome: string;
  op: Record<string, unknown> | undefined;
} {
  const root = isStringRecord(report) && isStringRecord(report.report) ? report.report : report;
  const outcome =
    isStringRecord(root) && typeof root.outcome === 'string' ? root.outcome : 'unrecognized';
  const operations = isStringRecord(root) && Array.isArray(root.operations) ? root.operations : [];
  const op = operations.find(
    (o): o is Record<string, unknown> => isStringRecord(o) && o.kind === 'create_document',
  );
  return { op, outcome };
}

/**
 * Cutover-only (MMR-144): write one pre-existing artifact record into the
 * vault at its *existing* identity — the same `KEY-aN` stem and the same
 * `created` — so ids and timestamps survive the migration and a re-run is
 * idempotent. Unlike `create`, it addresses a FIXED `create_document` path (no
 * `{{seq}}` allocation) and never re-stamps `created`; the frozen `content`
 * becomes the body. An already-migrated path (norn refuses a `create_document`
 * onto an existing destination) is the idempotency signal → `skipped`; every
 * other non-applied outcome fails loud. Delete alongside the migration command
 * once the vault is the sole backend.
 */
export async function restoreArtifact(
  client: NornClient,
  vaultRoot: string,
  record: ArtifactRecord,
  content: string,
): Promise<'created' | 'skipped'> {
  const path = pathOf(record.key, record.seq);
  const frontmatter = artifactFrontmatter({
    created: record.created_at,
    key: record.key,
    links: record.links,
    tags: record.tags,
    title: record.title,
  });
  const plan = migrationPlan({
    generator: 'mimir',
    operations: [createDocument(path, frontmatter, content)],
    vaultRoot,
  });
  const { op, outcome } = createReportOp(await client.applyPlan(plan, true));
  if (outcome === 'applied') {
    return 'created';
  }
  // A destination-already-exists refusal is idempotent ONLY if the occupant is
  // *this* artifact (a prior run of this same migration). Confirm by the
  // preserved identity fingerprint (`created` + `title`); a mismatch means the
  // stem is occupied by a different artifact (silent source/dest divergence),
  // and any non-collision failure fails loud rather than falsely reporting
  // `skipped`.
  //
  // The collision contract (verified empirically against norn 0.47.0): a
  // `create_document` destination collision reports plan `outcome: "refused"`
  // with the failed op's `status: "failed"` and `error.code: "internal-error"`
  // — the code is generic, so the message text is the only discriminator
  // available. The message is `create_document: destination already exists
  // (use --force to overwrite): <path>`, hence the `/already exists/i` match
  // below rather than a structured code check. A structured collision code
  // has been requested upstream; swap this match for it once norn ships one.
  const error = op !== undefined && isStringRecord(op.error) ? op.error : undefined;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (!/already exists/i.test(message)) {
    throw validation(
      'the artifact restore did not complete',
      message || `apply outcome: ${outcome}`,
    );
  }
  const existing = await client.get([path]);
  const doc = asDoc(existing[0]);
  const found = doc === null ? null : toRecord(doc);
  if (found !== null && found.created_at === record.created_at && found.title === record.title) {
    return 'skipped';
  }
  if (found === null) {
    // No occupant at the path: the loose text match caught an unrelated
    // failure, not a collision — surface norn's original error.
    throw validation('the artifact restore did not complete', message);
  }
  throw validation('the artifact restore collided with a different artifact', path);
}

/** Parse `KEY-aN` out of a vault path; null for non-artifact paths. */
function seqFromPath(path: string): { key: string; seq: number } | null {
  const match = /(?:^|\/)([A-Z]{2,4})-a(\d+)\.md$/.exec(path);
  return match ? { key: String(match[1]), seq: Number(match[2]) } : null;
}

/** A tool-result document with an optional body, narrowed from `unknown`. */
function asDoc(value: unknown): (NornDocument & { body?: unknown }) | null {
  if (!isStringRecord(value) || typeof value.path !== 'string') {
    return null;
  }
  const frontmatter = value.frontmatter;
  if (frontmatter !== undefined && !isStringRecord(frontmatter)) {
    return null;
  }
  return { body: value.body, frontmatter, path: value.path };
}

/** A frontmatter document → the backend-neutral record; null when malformed. */
function toRecord(doc: NornDocument): ArtifactRecord | null {
  const identity = seqFromPath(doc.path);
  const fm = doc.frontmatter;
  if (identity === null || fm === undefined) {
    return null;
  }
  const title = typeof fm.title === 'string' ? fm.title : '';
  const created = typeof fm.created === 'string' ? fm.created : '';
  const anchor = Array.isArray(fm.anchor) ? fm.anchor : [fm.anchor];
  const links = anchor.map(collapse).filter((s): s is string => s !== null);
  return {
    created_at: created,
    key: identity.key,
    links: links.toSorted(),
    seq: identity.seq,
    tags: stringList(fm.tags),
    title,
  };
}

export function createNornArtifactStore(client: NornClient, vaultRoot: string): ArtifactStore {
  /** All artifact docs for a project — the inventory read (listing/lookup). */
  const projectDocs = async (key: string): Promise<NornDocument[]> =>
    client.find({ eq: [`type:artifact`, `project:${key}`], no_limit: true });

  const loadDoc = async (
    key: string,
    seq: number,
    content: boolean,
  ): Promise<(ArtifactRecord & { content?: string }) | undefined> => {
    // Point-read by the deterministic path — `vault.get` resolves one document
    // and returns its frontmatter (and `.body` when asked). A missing target
    // yields no records rather than an error.
    const records = await client.get([pathOf(key, seq)], content ? '.body' : undefined);
    const doc = asDoc(records[0]);
    if (doc === null) {
      return undefined;
    }
    const record = toRecord(doc);
    if (record === null) {
      return undefined;
    }
    if (!content) {
      return record;
    }
    // Norn writes markdown with a trailing newline (POSIX convention); strip
    // one so content round-trips what was attached, verbatim. (A body
    // deliberately ending in `\n` loses that one newline —
    // benign for frozen markdown artifacts, and the sole content delta.)
    const raw = typeof doc.body === 'string' ? doc.body : '';
    return { ...record, content: raw.endsWith('\n') ? raw.slice(0, -1) : raw };
  };

  return {
    async applyTag(key, seq, tag) {
      const record = await loadDoc(key, seq, false);
      if (record === undefined) {
        return;
      }
      if (record.tags.includes(tag)) {
        return;
      }
      await client.set({
        confirm: true,
        set: { tags: [...record.tags, tag] },
        target: pathOf(key, seq),
      });
    },

    async create(input: ArtifactCreate) {
      // One `create_document` whose path carries the `KEY-a{{seq}}` token — Norn
      // allocates the next free per-directory sequence at apply time (the single
      // allocation authority), so there is no derived `max(seq)+1` and no
      // create-exclusive retry. The apply report echoes the resolved `KEY-aN`.
      const frontmatter = artifactFrontmatter({
        created: now(),
        key: input.key,
        links: input.links,
        tags: input.tags,
        title: input.title,
      });
      const plan = migrationPlan({
        generator: 'mimir',
        operations: [createDocument(createTemplate(input.key), frontmatter, input.content)],
        vaultRoot,
      });
      const { op, outcome } = createReportOp(await client.applyPlan(plan, true));
      if (outcome !== 'applied' || op === undefined || typeof op.stem !== 'string') {
        const error = op !== undefined && isStringRecord(op.error) ? op.error : undefined;
        const code = typeof error?.code === 'string' ? error.code : undefined;
        const message = typeof error?.message === 'string' ? error.message : undefined;
        const errorDetail = [code, message].filter((value) => value !== undefined).join(': ');
        throw validation(
          'the artifact create did not complete',
          `apply outcome: ${outcome}${errorDetail === '' ? '' : ` — ${errorDetail}`}`,
        );
      }
      const identity = parseIdentity(op.stem);
      if (identity?.kind !== 'artifact' || identity.key !== input.key) {
        throw invariant(`a created artifact resolved to an unexpected stem: ${op.stem}`);
      }
      return { key: input.key, seq: identity.seq };
    },

    async list(query: ArtifactListQuery) {
      const eq = ['type:artifact'];
      if (query.project !== undefined) {
        eq.push(`project:${query.project}`);
      }
      if (query.tag !== undefined) {
        eq.push(`tags:${query.tag}`);
      }
      const docs = await client.find({ eq, no_limit: true });
      const excluded = new Set(query.excludeProjects);
      let items = docs
        .map(toRecord)
        .filter((r): r is ArtifactRecord => r !== null)
        .filter((r) => !excluded.has(r.key));
      if (query.since !== undefined) {
        const since = query.since;
        items = items.filter((r) => r.created_at >= since);
      }
      if (query.before !== undefined) {
        const before = query.before;
        items = items.filter((r) => r.created_at <= before);
      }
      if (query.q !== undefined) {
        const q = query.q.toLowerCase();
        items = items.filter((r) => r.title.toLowerCase().includes(q));
      }
      // Newest-first, seq as the stable tiebreak (matches insertion order).
      items.sort((a, b) => {
        if (a.created_at !== b.created_at) {
          return a.created_at < b.created_at ? 1 : -1;
        }
        return b.seq - a.seq;
      });
      const total = items.length;
      const offset = query.offset ?? 0;
      return { items: items.slice(offset, offset + (query.limit ?? 100)), total };
    },

    async listForNode(nodeStem: string) {
      const docs = await client.find({
        eq: [`type:artifact`, `anchor:${nodeStem}`],
        no_limit: true,
      });
      return docs
        .map(toRecord)
        .filter((r): r is ArtifactRecord => r !== null)
        .toSorted((a, b) => a.seq - b.seq);
    },

    async listForProject(key: string) {
      const docs = await projectDocs(key);
      return docs
        .map(toRecord)
        .filter((r): r is ArtifactRecord => r !== null)
        .toSorted((a, b) => a.seq - b.seq);
    },

    async load(key, seq, opts) {
      return loadDoc(key, seq, opts?.content === true);
    },

    async removeTags(key, seq, tags) {
      const record = await loadDoc(key, seq, false);
      if (record === undefined || tags.length === 0) {
        return 0;
      }
      const removing = new Set(tags);
      const remaining = record.tags.filter((t) => !removing.has(t));
      const removed = record.tags.length - remaining.length;
      if (removed > 0) {
        await client.set({
          confirm: true,
          set: { tags: remaining },
          target: pathOf(key, seq),
        });
      }
      return removed;
    },

    async updateTitle(key, seq, title) {
      const record = await loadDoc(key, seq, false);
      if (record === undefined) {
        return false;
      }
      await client.set({ confirm: true, set: { title }, target: pathOf(key, seq) });
      return true;
    },
  };
}
