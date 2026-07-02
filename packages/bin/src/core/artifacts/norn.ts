import type { NornClient, NornDocument } from '../../norn/client';
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
 *   so a concurrent-create collision re-derives and retries (bounded).
 * - **Anchors may dangle during the split** (nodes still in SQLite until
 *   Phase 3): links are written as real wikilinks and queried as stored text
 *   (Norn collapses brackets in field matching) — ADR 0016 Refinement.
 * - **Tag notes are rejected**: frontmatter `tags` are plain strings; a
 *   `--note` on a vault-backed artifact has nowhere faithful to live.
 * - **`q` search rides Norn's `contains`** (title) — case-sensitive literal
 *   matching vs SQLite's case-insensitive LIKE over title+content; a
 *   documented transitional delta of the flag, not a silent one.
 */

const CREATE_RETRIES = 5;

const stemOf = (key: string, seq: number): string => renderArtifactRef({ key, seq });
const pathOf = (key: string, seq: number): string => `${key}/artifacts/${stemOf(key, seq)}.md`;

/** Parse `KEY-aN` out of a vault path; null for non-artifact paths. */
function seqFromPath(path: string): { key: string; seq: number } | null {
  const match = /(?:^|\/)([A-Z]{2,4})-a(\d+)\.md$/.exec(path);
  return match ? { key: String(match[1]), seq: Number(match[2]) } : null;
}

/** Collapse `[[STEM]]` (or a bare stem) to the stem text. */
function collapse(link: unknown): string | null {
  if (typeof link !== 'string') {
    return null;
  }
  const inner = link.startsWith('[[') && link.endsWith(']]') ? link.slice(2, -2) : link;
  return inner === '' ? null : inner;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === 'string');
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    tags: asStringArray(fm.tags),
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
    // one so content round-trips what was attached, matching SQLite's verbatim
    // storage. (A body deliberately ending in `\n` loses that one newline —
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
      const fields = (title: string): string[] => {
        const json: string[] = [
          `type=${JSON.stringify('artifact')}`,
          `title=${JSON.stringify(title)}`,
          `project=${JSON.stringify(`[[${input.key}]]`)}`,
          `created=${JSON.stringify(now())}`,
        ];
        if (input.links.length > 0) {
          json.push(`anchor=${JSON.stringify(input.links.map((stem) => `[[${stem}]]`))}`);
        }
        if (input.tags.length > 0) {
          json.push(`tags=${JSON.stringify(input.tags)}`);
        }
        return json;
      };
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
            field_json: fields(input.title),
            parents: true,
            path: pathOf(input.key, seq),
          });
          return { key: input.key, seq };
        } catch (error) {
          // create-exclusive: an existing path means a concurrent create won
          // the seq — re-derive and retry (ADR 0016 fork #1's fallback).
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
      // Newest-first, seq as the stable tiebreak (SQLite used insert order).
      items.sort((a, b) => {
        if (a.created_at !== b.created_at) {
          return a.created_at < b.created_at ? 1 : -1;
        }
        return b.seq - a.seq;
      });
      const total = items.length;
      return { items: items.slice(0, query.limit ?? 100), total };
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
