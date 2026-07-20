import type {
  ArtifactCreate,
  ArtifactListQuery,
  ArtifactRecord,
  ArtifactStore,
} from '../artifacts/store';
import { degradedUpdatedAt, invariant, validation } from '../errors';
import { parseIdentity, renderArtifactRef, wikilink } from '../ids';
import { now } from '../time';
import { applyReportOutcome, createdStem, decodeApplyReport } from './apply-report';
import type { NornClient, NornDocument } from './client';
import { collapse, isStringRecord, stringList } from './decode';
import type { MigrationOp } from './plan';
import {
  addFrontmatter,
  createDocumentPlan,
  migrationPlan,
  SEQ_TOKEN,
  setFrontmatter,
} from './plan';

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
 * has, matching the pre-seam markdown. `updated_at` is always emitted (like the
 * seed rule): every mutation co-writes it as the CAS drift guard (MMR-317).
 */
function artifactFrontmatter(fields: {
  key: string;
  title: string;
  created: string;
  updated_at: string;
  links: string[];
  tags: string[];
}): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    created: fields.created,
    project: wikilink(fields.key),
    title: fields.title,
    type: 'artifact',
    updated_at: fields.updated_at,
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
 * Refuse a mutating artifact write whose loaded `updated_at` is absent or null
 * (MMR-317). Every artifact mutation co-writes the `updated_at` stamp as its CAS
 * drift guard, carrying `fm.updated_at` as norn's `expected_old_value`; a
 * missing/null field would emit an unguarded null old value — a silent
 * guard-less write. Mirrors the seed store's `assertSeedGuard` (MMR-313) and the
 * node/project write path's co-write invariant (MMR-303): fail closed at the
 * shared degraded-vault refusal and point the operator at `mimir doctor --fix`.
 * `create` needs no guard — a `create_document` is birth, not drift.
 */
function assertArtifactGuard(path: string, fm: Record<string, unknown>): void {
  if (fm.updated_at === undefined || fm.updated_at === null) {
    throw degradedUpdatedAt(path);
  }
}

/** Choose add vs set for the `tags` field on the RAW field PRESENCE (matching
 * the seed store's `spawnedFieldOp`): an absent field is ADDed, a present one is
 * SET carrying its raw stored value as the CAS precondition — norn refuses to
 * add a present field, and an omitted precondition on a set asserts absence. */
function tagsFieldOp(path: string, fm: Record<string, unknown>, tags: string[]): MigrationOp {
  return 'tags' in fm
    ? setFrontmatter(path, 'tags', tags, fm.tags)
    : addFrontmatter(path, 'tags', tags);
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
    // Preserve the source `updated_at` across the migration so a re-run is
    // idempotent; a legacy artifact predating the field falls back to `created`
    // (the migration is birth-for-the-vault, so a real stamp must exist).
    updated_at: record.updated_at === '' ? record.created_at : record.updated_at,
  });
  const plan = createDocumentPlan(vaultRoot, path, frontmatter, content);
  const { operations, outcome } = decodeApplyReport(await client.applyPlan(plan, true));
  if (outcome === 'applied') {
    return 'created';
  }
  const op = operations.find((o) => o.kind === 'create_document');
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
  const message = op?.error?.message ?? '';
  if (!/already exists/i.test(message)) {
    throw validation(
      'the artifact restore did not complete',
      message || `apply outcome: ${outcome ?? 'unrecognized'}`,
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

/**
 * Norn writes markdown with a trailing newline (POSIX convention): a body
 * lacking one gets one appended at write time, while a body already ending in
 * `\n` is written as-is. Either way the file ends in exactly one trailing
 * `\n`, so stripping one on read round-trips a no-trailing-newline body
 * exactly (a trailing-newline body deliberately loses that one newline — the
 * sole content delta, benign for frozen markdown). Applying this SAME strip
 * directly to the input body (rather than the file `create` just wrote)
 * yields the identical result without a read-back (MMR-283).
 */
function stripTrailingNewline(body: string): string {
  return body.endsWith('\n') ? body.slice(0, -1) : body;
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
    // Tolerant of a legacy artifact predating the field (string-or-empty, like
    // seeds): reads as `''`, which the mutation guard then refuses (MMR-317).
    updated_at: typeof fm.updated_at === 'string' ? fm.updated_at : '',
  };
}

export function createNornArtifactStore(client: NornClient, vaultRoot: string): ArtifactStore {
  /** All artifact docs for a project — the inventory read (listing/lookup). */
  const projectDocs = async (key: string): Promise<NornDocument[]> =>
    client.find({ eq: [`type:artifact`, `project:${key}`], no_limit: true });

  // The typed record PLUS the raw frontmatter and path — the mutation path needs
  // the raw stored values as norn's `expected_old_value` compare-and-set
  // precondition (an omitted precondition asserts the field is ABSENT, so
  // overwriting a present field must carry its current value), mirroring the seed
  // store's loader (MMR-313).
  const resolveDoc = async (
    key: string,
    seq: number,
    content: boolean,
  ): Promise<
    | { record: ArtifactRecord; fm: Record<string, unknown>; path: string; content?: string }
    | undefined
  > => {
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
    const fm = isStringRecord(doc.frontmatter) ? doc.frontmatter : {};
    if (!content) {
      return { fm, path: doc.path, record };
    }
    // Round-trip the frozen body verbatim — see stripTrailingNewline.
    const raw = typeof doc.body === 'string' ? doc.body : '';
    return { content: stripTrailingNewline(raw), fm, path: doc.path, record };
  };

  /** Apply a one-plan batch of ops, failing loud if norn did not fully apply it —
   * the single-shot mutation path (an unconfirmed apply is terminal). Every
   * mutation appends the `updated_at` co-write, so the plan is never empty. */
  const apply = async (operations: MigrationOp[]): Promise<void> => {
    const plan = migrationPlan({ generator: 'mimir', operations, vaultRoot });
    const outcome = applyReportOutcome(await client.applyPlan(plan, true)) ?? 'unrecognized';
    if (outcome !== 'applied') {
      throw validation('the artifact write did not complete', `apply outcome: ${outcome}`);
    }
  };

  return {
    async applyTag(key, seq, tag) {
      const doc = await resolveDoc(key, seq, false);
      if (doc === undefined) {
        return;
      }
      // A no-op re-tag writes nothing (MMR-303 posture): no plan, no stamp.
      if (doc.record.tags.includes(tag)) {
        return;
      }
      assertArtifactGuard(doc.path, doc.fm);
      await apply([
        tagsFieldOp(doc.path, doc.fm, [...doc.record.tags, tag]),
        setFrontmatter(doc.path, 'updated_at', now(), doc.fm.updated_at),
      ]);
    },

    async create(input: ArtifactCreate) {
      // One `create_document` whose path carries the `KEY-a{{seq}}` token — Norn
      // allocates the next free per-directory sequence at apply time (the single
      // allocation authority), so there is no derived `max(seq)+1` and no
      // create-exclusive retry. The apply report echoes the resolved `KEY-aN`.
      const timestamp = now();
      const frontmatter = artifactFrontmatter({
        created: timestamp,
        key: input.key,
        links: input.links,
        tags: input.tags,
        title: input.title,
        updated_at: timestamp,
      });
      const plan = createDocumentPlan(
        vaultRoot,
        createTemplate(input.key),
        frontmatter,
        input.content,
      );
      const result = createdStem(await client.applyPlan(plan, true));
      if ('failure' in result) {
        throw validation('the artifact create did not complete', result.failure);
      }
      const identity = parseIdentity(result.stem);
      if (identity?.kind !== 'artifact' || identity.key !== input.key) {
        throw invariant(`a created artifact resolved to an unexpected stem: ${result.stem}`);
      }
      // Echo the record IN FULL from what was just written (MMR-283, mirroring the
      // seed store's create): every field is either the create input or derived
      // locally (the resolved seq, the stamped `created`), so a caller building a
      // create response never needs a follow-up `load`. `content` is normalized to
      // the read-back semantics (stripTrailingNewline) so the echo equals a
      // subsequent load's content exactly.
      return {
        content: stripTrailingNewline(input.content),
        created_at: timestamp,
        key: input.key,
        // toRecord() sorts `links` on read (see toRecord below) — match that
        // order here so the echo equals a subsequent load's `links` exactly,
        // regardless of the caller's link order.
        links: input.links.toSorted(),
        seq: identity.seq,
        tags: input.tags,
        title: input.title,
        updated_at: timestamp,
      };
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
      const doc = await resolveDoc(key, seq, opts?.content === true);
      if (doc === undefined) {
        return undefined;
      }
      return doc.content === undefined ? doc.record : { ...doc.record, content: doc.content };
    },

    async removeTags(key, seq, tags) {
      const doc = await resolveDoc(key, seq, false);
      if (doc === undefined || tags.length === 0) {
        return 0;
      }
      const removing = new Set(tags);
      const remaining = doc.record.tags.filter((t) => !removing.has(t));
      const removed = doc.record.tags.length - remaining.length;
      // A no-op removal writes nothing (MMR-303 posture): no plan, no stamp.
      if (removed === 0) {
        return 0;
      }
      assertArtifactGuard(doc.path, doc.fm);
      await apply([
        tagsFieldOp(doc.path, doc.fm, remaining),
        setFrontmatter(doc.path, 'updated_at', now(), doc.fm.updated_at),
      ]);
      return removed;
    },

    async updateTitle(key, seq, title) {
      const doc = await resolveDoc(key, seq, false);
      if (doc === undefined) {
        return false;
      }
      assertArtifactGuard(doc.path, doc.fm);
      await apply([
        setFrontmatter(doc.path, 'title', title, doc.fm.title),
        setFrontmatter(doc.path, 'updated_at', now(), doc.fm.updated_at),
      ]);
      return true;
    },
  };
}
