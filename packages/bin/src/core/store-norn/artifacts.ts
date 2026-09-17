import type {
  ArtifactCreate,
  ArtifactListQuery,
  ArtifactMetadataPatch,
  ArtifactRecord,
  ArtifactStore,
} from '../artifacts/store';
import { withinWindow } from '../dates';
import { degradedUpdatedAt, invariant, validation } from '../errors';
import type { ExportedArtifact } from '../export';
import { parseIdentity, renderArtifactRef, wikilink } from '../ids';
import { now } from '../time';
import { applyReportOutcome, createdStem, decodeApplyReport } from './apply-report';
import type { ChunkLimits } from './chunking';
import { ASSUMED_BODY_BYTES, jsonBytes, READ_LIMITS, readBodies } from './chunking';
import type { NornClient, NornDocument } from './client';
import { collapse, isStringRecord, stringList } from './decode';
import type { MigrationOp } from './plan';
import {
  addFrontmatter,
  createDocumentPlan,
  migrationPlan,
  removeFrontmatter,
  SEQ_TOKEN,
  setFrontmatter,
} from './plan';
import type { RawDocument } from './raw-write';

/**
 * The Norn-vault `ArtifactStore` (MMR-143, ADR 0016 Phase 2a): an artifact is
 * a markdown document at `KEY/artifacts/KEY-aN.md` — the stem is the id,
 * frontmatter is the queryable record (`title`, the optional `summary` lede,
 * `project` wikilink, `anchor` wikilink list, `tags`, `created`), the body is
 * the frozen content.
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
 * cutover `restoreArtifact` (which preserves the source `created`). `anchor`,
 * `summary`, and `tags` are omitted when empty so an artifact carries only the
 * fields it has, matching the pre-seam markdown. `updated_at` is always emitted
 * (like the seed rule): every mutation co-writes it as the CAS drift guard
 * (MMR-317).
 */
function artifactFrontmatter(fields: {
  key: string;
  title: string;
  summary: string | null;
  created: string;
  updated_at: string;
  links: string[];
  tags: string[];
  sourceScratch?: string;
}): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    ...(fields.created === '' ? {} : { created: fields.created }),
    project: wikilink(fields.key),
    title: fields.title,
    type: 'artifact',
    // An EMPTY stamp means the source document carried none — the tolerant read
    // in `toRecord` yields `''` for a legacy artifact predating the field. Write
    // the absence back as absence rather than inventing a value: a store import
    // preserves facts verbatim, and healing a degraded document is `mimir
    // doctor --fix`'s decision to make, not a copy's (ADR 0017). `create`
    // always stamps, so this only ever omits on a restore or an import.
    ...(fields.updated_at === '' ? {} : { updated_at: fields.updated_at }),
  };
  if (fields.links.length > 0) {
    fm.anchor = fields.links.map(wikilink);
  }
  if (fields.summary !== null) {
    fm.summary = fields.summary;
  }
  if (fields.tags.length > 0) {
    fm.tags = fields.tags;
  }
  if (fields.sourceScratch !== undefined) {
    fm.source_scratch = fields.sourceScratch;
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

/** The `summary` field op for one metadata patch (MMR-319), chosen on the RAW
 * field PRESENCE like {@link tagsFieldOp}: a value ADDs an absent field and SETs
 * a present one under its stored CAS precondition, while a null CLEARS — a
 * remove carrying the same precondition, or nothing at all when the field is
 * already absent (the no-op posture: no op, no stamp). */
function summaryFieldOp(
  path: string,
  fm: Record<string, unknown>,
  summary: string | null,
): MigrationOp | undefined {
  if (summary === null) {
    return 'summary' in fm ? removeFrontmatter(path, 'summary', fm.summary) : undefined;
  }
  return 'summary' in fm
    ? setFrontmatter(path, 'summary', summary, fm.summary)
    : addFrontmatter(path, 'summary', summary);
}

/**
 * The complete physical document one artifact record + its frozen content
 * becomes — the same path, frontmatter, and body a `create` writes, only at the
 * record's EXISTING identity instead of an allocated one. The single builder
 * behind every fixed-path artifact write ({@link restoreArtifact} and the store
 * import, ADR 0030 Decision 4), so a restored or imported artifact is
 * byte-identical to a created one.
 */
export function artifactDocument(
  record: ArtifactRecord & { content: string; source_scratch?: string | null },
): RawDocument {
  const frontmatter = artifactFrontmatter({
    // Empty passes through as absent, like the stamp below — a legacy artifact
    // with no `created` reads as `''` and must import back that way.
    created: record.created_at,
    key: record.key,
    links: record.links,
    summary: record.summary,
    tags: record.tags,
    title: record.title,
    // Passed through as-is, empty included: see {@link artifactFrontmatter} —
    // an absent stamp is a fact of the source document, not a gap to fill.
    // `restoreArtifact` substitutes `created` itself, because a one-way cutover
    // to a new substrate legitimately makes that call and an import does not.
    updated_at: record.updated_at,
    ...(record.source_scratch == null ? {} : { sourceScratch: record.source_scratch }),
  });
  return {
    // The content is re-terminated, not written raw. Norn appends a trailing
    // newline only when one is absent, and {@link stripTrailingNewline} removes
    // exactly one on read — so writing a READ-BACK content verbatim sheds one
    // more newline on every hop, and an artifact whose stored body ends in a
    // blank line loses it. `content + '\n'` is the fixpoint of that pair: the
    // file always ends in exactly the newlines the source file had, so the
    // round trip is stable no matter how many times it runs.
    body: `${record.content}\n`,
    frontmatter,
    path: pathOf(record.key, record.seq),
  };
}

/**
 * Every artifact in the vault with its frozen content and `source_scratch` — the
 * store export's artifact collection (MMR-378, ADR 0030 Decision 4).
 *
 * Two phases, because artifact bodies are the largest thing in a vault and the
 * MCP transport drops a response that grows too big (NRN-s30, see
 * {@link ./chunking}): a metadata-only `find` enumerates every artifact, then
 * the frozen bodies are fetched in byte-bounded `vault.get` chunks. The whole
 * set in one `find` with `.body` is what fails on a real vault.
 *
 * Decodes through the same {@link toRecord} + {@link stripTrailingNewline} the
 * seam's reads use, so an exported artifact equals what
 * `load(..., {content: true})` would return. `source_scratch` is read raw here
 * because no seam record carries it (only `findBySourceScratch` surfaces it),
 * yet it is stored and must survive a round trip.
 */
export async function exportArtifacts(
  client: NornClient,
  limits: ChunkLimits = READ_LIMITS,
): Promise<ExportedArtifact[]> {
  const docs = await client.find({
    col: ['.frontmatter'],
    eq: ['type:artifact'],
    no_limit: true,
  });
  const candidates = docs.flatMap((raw) => {
    const doc = asDoc(raw);
    const record = doc === null ? null : toRecord(doc);
    return doc === null || record === null ? [] : [{ doc, record }];
  });
  const bodies = await readBodies(
    client,
    candidates.map((candidate) => ({
      path: candidate.doc.path,
      // The frontmatter is already in hand, so only the body is a guess.
      weight: jsonBytes(candidate.doc.frontmatter) + ASSUMED_BODY_BYTES,
    })),
    limits,
  );
  const exported: ExportedArtifact[] = [];
  for (const candidate of candidates) {
    const sourceScratch = candidate.doc.frontmatter?.source_scratch;
    exported.push({
      ...candidate.record,
      content: stripTrailingNewline(bodies.get(candidate.doc.path) ?? ''),
      source_scratch: typeof sourceScratch === 'string' ? sourceScratch : null,
    });
  }
  return exported.toSorted((a, b) =>
    a.key === b.key ? a.seq - b.seq : a.key.localeCompare(b.key),
  );
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
  // The source `created` and `updated_at` are preserved across the migration (so
  // a re-run is idempotent) by the shared document builder. A legacy artifact
  // predating `updated_at` falls back to `created` HERE and not in the builder:
  // this is a one-way cutover to a new substrate, so every migrated document
  // gets a real stamp for the mutation guard (MMR-317), while a store import
  // copies the absence through untouched.
  const { frontmatter, path } = artifactDocument({
    ...record,
    content,
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
    // Absent by design (MMR-319) — the lede is optional, so a missing or
    // non-string field reads as none, never as a decode failure.
    summary: typeof fm.summary === 'string' ? fm.summary : null,
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
      const summary = input.summary ?? null;
      const frontmatter = artifactFrontmatter({
        created: timestamp,
        key: input.key,
        links: input.links,
        sourceScratch: input.sourceScratch,
        summary,
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
        summary,
        tags: input.tags,
        title: input.title,
        updated_at: timestamp,
      };
    },

    async findBySourceScratch(id) {
      const docs = await client.find({
        col: ['.frontmatter', '.body'],
        eq: ['type:artifact', `source_scratch:${id}`],
        no_limit: true,
      });
      const matches = docs
        .map(asDoc)
        .filter((doc): doc is NornDocument & { body?: unknown } => doc !== null)
        .map((doc) => {
          const record = toRecord(doc);
          return record === null || typeof doc.body !== 'string'
            ? null
            : Object.assign(record, { content: stripTrailingNewline(doc.body) });
        })
        .filter((record): record is ArtifactRecord & { content: string } => record !== null);
      if (matches.length > 1) {
        throw invariant(`scratchpad ${id} produced more than one artifact`);
      }
      return matches[0];
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
      if (query.created !== undefined) {
        const created = query.created;
        items = items.filter((r) => withinWindow(created, r.created_at));
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

    async updateMetadata(key, seq, patch: ArtifactMetadataPatch) {
      const doc = await resolveDoc(key, seq, false);
      if (doc === undefined) {
        return false;
      }
      const ops: MigrationOp[] = [];
      if (patch.title !== undefined) {
        ops.push(setFrontmatter(doc.path, 'title', patch.title, doc.fm.title));
      }
      if (patch.summary !== undefined) {
        const op = summaryFieldOp(doc.path, doc.fm, patch.summary);
        if (op !== undefined) {
          ops.push(op);
        }
      }
      // A patch that changes nothing writes nothing (MMR-303 posture): clearing
      // an already-absent summary is the one reachable case.
      if (ops.length === 0) {
        return true;
      }
      assertArtifactGuard(doc.path, doc.fm);
      await apply([...ops, setFrontmatter(doc.path, 'updated_at', now(), doc.fm.updated_at)]);
      return true;
    },
  };
}
