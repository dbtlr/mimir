import type { NornClient, NornDocument } from '../../norn/client';
import { isPathCollision } from '../../norn/client';
import { collapse, isStringRecord, stringList } from '../../norn/decode';
import { validation } from '../errors';
import { renderArtifactRef } from '../ids';
import { now } from '../time';
import type { ArtifactCreate, ArtifactListQuery, ArtifactRecord, ArtifactStore } from './store';

/**
 * The Norn-vault `ArtifactStore` (MMR-143, ADR 0016 Phase 2a): an artifact is
 * a markdown document at `KEY/artifacts/KEY-aN.md` — the stem is the id,
 * frontmatter is the queryable record (`title`, `project` wikilink, `anchor`
 * wikilink list, `tags`, `created`), the body is the frozen content.
 *
 * - **Seq allocation is derived**: `max(seq)+1` over the project's artifact
 *   stems, with create-exclusive retry — `vault.new` refuses an existing path,
 *   so a concurrent-create collision re-derives and retries (bounded). A
 *   derived max *reuses* a seq if the highest artifact file is removed —
 *   harmless here because artifacts are append-only and never deleted (ADR
 *   0004; a hand-deletion is out of contract), and the id↔int layer thins to
 *   the stem regardless (ADR 0016).
 * - **Anchors may dangle during the split**: links are written as real
 *   wikilinks and queried as stored text (Norn collapses brackets in field
 *   matching) — ADR 0016 Refinement.
 * - **Tag notes are rejected**: frontmatter `tags` are plain strings; a
 *   `--note` on a vault-backed artifact has nowhere faithful to live.
 * - **`q` search is case-insensitive and title-only** (in-process
 *   `toLowerCase().includes` over the loaded records); the title-only scope is
 *   the documented delta from the flag's prior title+content behavior.
 */

const CREATE_RETRIES = 5;

const stemOf = (key: string, seq: number): string => renderArtifactRef({ key, seq });
const pathOf = (key: string, seq: number): string => `${key}/artifacts/${stemOf(key, seq)}.md`;

/**
 * The artifact frontmatter as `vault.new` `field_json` entries — the single
 * write shape shared by `create` (which stamps `created=now()`) and the
 * cutover `restoreArtifact` (which preserves the source `created`). `anchor`
 * and `tags` are omitted when empty so an artifact carries only the fields it
 * has, matching the pre-seam markdown.
 */
function artifactFieldJson(fields: {
  key: string;
  title: string;
  created: string;
  links: string[];
  tags: string[];
}): string[] {
  const json: string[] = [
    `type=${JSON.stringify('artifact')}`,
    `title=${JSON.stringify(fields.title)}`,
    `project=${JSON.stringify(`[[${fields.key}]]`)}`,
    `created=${JSON.stringify(fields.created)}`,
  ];
  if (fields.links.length > 0) {
    json.push(`anchor=${JSON.stringify(fields.links.map((stem) => `[[${stem}]]`))}`);
  }
  if (fields.tags.length > 0) {
    json.push(`tags=${JSON.stringify(fields.tags)}`);
  }
  return json;
}

/**
 * Cutover-only (MMR-144): write one pre-existing artifact record into the
 * vault at its *existing* identity — the same `KEY-aN` stem and the same
 * `created` — so
 * ids and timestamps survive the migration and a re-run is idempotent. Unlike
 * `create`, it never derives a fresh seq or re-stamps `created`; the frozen
 * `content` becomes the body. An already-migrated path (create-exclusive
 * `vault.new` refuses it) is the idempotency signal → `skipped`; every other
 * error propagates so the run fails loudly. Delete alongside the migration
 * command once the vault is the sole backend.
 */
export async function restoreArtifact(
  client: NornClient,
  record: ArtifactRecord,
  content: string,
): Promise<'created' | 'skipped'> {
  try {
    await client.newDoc({
      body: content,
      confirm: true,
      field_json: artifactFieldJson({
        created: record.created_at,
        key: record.key,
        links: record.links,
        tags: record.tags,
        title: record.title,
      }),
      parents: true,
      path: pathOf(record.key, record.seq),
    });
    return 'created';
  } catch (error) {
    if (!isPathCollision(error)) {
      throw error;
    }
    // A path already exists — idempotent ONLY if it is *this* artifact (a prior
    // run of this same migration). Confirm by the preserved identity
    // fingerprint (`created` + `title`); a mismatch means the stem is occupied
    // by a different artifact (silent source/dest divergence), and a missing
    // doc means the loose collision match caught an unrelated error — either
    // way, rethrow rather than falsely report `skipped`.
    const existing = await client.get([pathOf(record.key, record.seq)]);
    const doc = asDoc(existing[0]);
    const found = doc === null ? null : toRecord(doc);
    if (found !== null && found.created_at === record.created_at && found.title === record.title) {
      return 'skipped';
    }
    throw error;
  }
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

export function createNornArtifactStore(client: NornClient): ArtifactStore {
  /** All artifact docs for a project — the seq-derivation and inventory read. */
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
    async applyTag(key, seq, tag, note) {
      if (note !== null) {
        throw validation(
          'tag notes are not supported on vault-backed artifacts',
          'frontmatter tags are plain strings — apply the tag without --note',
        );
      }
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
      // Stamped once, not per retry: a create-exclusive collision re-derives the
      // seq, but the artifact's `created` should not drift across attempts.
      const field_json = artifactFieldJson({
        created: now(),
        key: input.key,
        links: input.links,
        tags: input.tags,
        title: input.title,
      });
      let lastError: unknown;
      for (let attempt = 0; attempt < CREATE_RETRIES; attempt += 1) {
        const docs = await projectDocs(input.key);
        const seqs = docs
          .map((d) => seqFromPath(d.path))
          .filter((s): s is { key: string; seq: number } => s !== null)
          .map((s) => s.seq);
        const seq = (seqs.length === 0 ? 0 : Math.max(...seqs)) + 1;
        try {
          await client.newDoc({
            body: input.content,
            confirm: true,
            field_json,
            parents: true,
            path: pathOf(input.key, seq),
          });
          return { key: input.key, seq };
        } catch (error) {
          // ONLY a create-exclusive path collision means a concurrent create
          // won this seq — re-derive and retry (ADR 0016 fork #1). Any other
          // failure (incl. an ambiguous post-write RPC loss) rethrows: retrying
          // there would re-derive a *higher* seq and write a duplicate.
          if (!isPathCollision(error)) {
            throw error;
          }
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : validation(`artifact create kept colliding after ${String(CREATE_RETRIES)} attempts`);
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
