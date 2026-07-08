import { SEED_KIND_VALUES, SEED_LIFECYCLE_VALUES } from '@mimir/contract';
import type { SeedKind, SeedLifecycle } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import type { NornClient, NornDocument } from '../../norn/client';
import { migrationPlan } from '../../norn/plan';
import type { MigrationOp } from '../../norn/plan';
import {
  addFrontmatter,
  appendToSection,
  replaceSection,
  setFrontmatter,
} from '../../norn/plan';
import { collapse, pathAndSections } from '../../norn/decode';
import { validation } from '../errors';
import {
  HISTORY_HEADING,
  parseDescriptionSection,
  renderDescriptionSection,
  renderHistoryRecord,
  renderSeedBody,
  SEED_DESCRIPTION_HEADING,
  sectionBody,
} from '../history-codec';
import { renderSeedRef, wikilink } from '../ids';
import { now } from '../time';
import type { SeedCreate, SeedPatch, SeedRecord, SeedStore } from './store';
import { canTransitionSeed, isTerminalSeed } from './store';

/**
 * The Norn-vault `SeedStore` (MMR-244) — a seed is a markdown document at
 * `KEY/seeds/KEY-sN.md`, sibling of `KEY/artifacts/` (ADR 0004 precedent). The
 * stem is the id; frontmatter is the queryable record (`title`, `project`
 * wikilink, `kind`, `lifecycle`, nullable `requester` project key, `spawned`
 * wikilink list, `created`/`updated_at`); the body carries the full sectioned
 * shape (`## Seed Description` + `## History` + `## Annotations`) through the
 * shared history codec, exactly as a task doc does.
 *
 * - **Seq allocation is derived**, mirroring the artifact store: `max(seq)+1`
 *   over the project's seed stems, with create-exclusive retry — `vault.new`
 *   refuses an existing path, so a concurrent collision re-derives and retries.
 * - **Section-touching mutations ride `vault.apply`** (the same atomic plan
 *   machinery the node write path uses): a lifecycle transition is one plan
 *   carrying the `lifecycle` set + the `## History` append, so the frontmatter
 *   and the log can never diverge. Frontmatter-only edits ride the same plan.
 * - **The lifecycle machine and terminal-freeze live here** (the store/mutation
 *   layer): `patch` refuses a terminal seed, `transition` refuses an illegal edge.
 */

const CREATE_RETRIES = 5;

/**
 * Is this the create-exclusive path collision — the only error `create` may
 * safely retry? Norn's `vault.new` on an existing path fails with "already
 * exists"; the NornClient wraps it, so we match the message text (the artifact
 * store makes the same match).
 */
function isPathCollision(error: unknown): boolean {
  return error instanceof Error && /already exists/i.test(error.message);
}

const stemOf = (key: string, seq: number): string => renderSeedRef({ key, seq });
const pathOf = (key: string, seq: number): string => `${key}/seeds/${stemOf(key, seq)}.md`;

/** Parse `KEY-sN` out of a vault seed path; null for non-seed paths. */
function seqFromPath(path: string): { key: string; seq: number } | null {
  const match = /(?:^|\/)([A-Z]{2,4})-s(\d+)\.md$/.exec(path);
  return match ? { key: String(match[1]), seq: Number(match[2]) } : null;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function narrowKind(value: unknown): SeedKind | null {
  return typeof value === 'string' && isMember(value, SEED_KIND_VALUES) ? value : null;
}

function narrowLifecycle(value: unknown): SeedLifecycle | null {
  return typeof value === 'string' && isMember(value, SEED_LIFECYCLE_VALUES) ? value : null;
}

/** A wikilink list (scalar or array) → its collapsed stems, in frontmatter order. */
function linkStems(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.map(collapse).filter((s): s is string => s !== null);
}

/**
 * A seed document → the backend-neutral record; null when malformed (no seed
 * stem, no frontmatter, or a foreign kind/lifecycle). The read path is tolerant
 * (ADR 0017): a seed the validator would drop reads as absent rather than
 * throwing.
 */
function toRecord(doc: NornDocument): SeedRecord | null {
  const identity = seqFromPath(doc.path);
  const fm = doc.frontmatter;
  if (identity === null || fm === undefined) {
    return null;
  }
  const kind = narrowKind(fm.kind);
  const lifecycle = narrowLifecycle(fm.lifecycle);
  if (kind === null || lifecycle === null) {
    return null;
  }
  const requester = collapse(fm.requester);
  return {
    created_at: typeof fm.created === 'string' ? fm.created : '',
    key: identity.key,
    kind,
    lifecycle,
    requester,
    seq: identity.seq,
    spawned: linkStems(fm.spawned),
    title: typeof fm.title === 'string' ? fm.title : '',
    updated_at: typeof fm.updated_at === 'string' ? fm.updated_at : '',
  };
}

/**
 * The seed frontmatter as `vault.new` `field_json` entries — `requester` and
 * `spawned` are omitted when empty so a seed carries only the fields it has,
 * matching the omit-empty node/artifact shape. `project` and `requester` are
 * wikilinks (Norn collapses brackets in matching); `spawned` is a wikilink list.
 */
function seedFieldJson(fields: {
  key: string;
  title: string;
  kind: SeedKind;
  lifecycle: SeedLifecycle;
  requester: string | null;
  spawned: string[];
  created: string;
  updated_at: string;
}): string[] {
  const json: string[] = [
    `type=${JSON.stringify('seed')}`,
    `title=${JSON.stringify(fields.title)}`,
    `project=${JSON.stringify(wikilink(fields.key))}`,
    `kind=${JSON.stringify(fields.kind)}`,
    `lifecycle=${JSON.stringify(fields.lifecycle)}`,
    `created=${JSON.stringify(fields.created)}`,
    `updated_at=${JSON.stringify(fields.updated_at)}`,
  ];
  if (fields.requester !== null) {
    json.push(`requester=${JSON.stringify(wikilink(fields.requester))}`);
  }
  if (fields.spawned.length > 0) {
    json.push(`spawned=${JSON.stringify(fields.spawned.map(wikilink))}`);
  }
  return json;
}

export function createNornSeedStore(client: NornClient, vaultRoot: string): SeedStore {
  /** All seed docs for a project — the seq-derivation and inventory read. */
  const projectDocs = async (key: string): Promise<NornDocument[]> =>
    client.find({ eq: [`type:seed`, `project:${key}`], no_limit: true });

  // The typed record plus the RAW frontmatter — the mutation path needs the raw
  // stored values as norn's `expected_old_value` compare-and-set precondition
  // (an omitted precondition asserts the field is ABSENT, so overwriting a present
  // field must carry its current value, exactly as the node write path does).
  const loadDoc = async (
    key: string,
    seq: number,
  ): Promise<{ record: SeedRecord; fm: Record<string, unknown> } | undefined> => {
    const records = await client.get([pathOf(key, seq)]);
    const doc = records[0];
    if (!isStringRecord(doc) || typeof doc.path !== 'string') {
      return undefined;
    }
    const fm = isStringRecord(doc.frontmatter) ? doc.frontmatter : {};
    const record = toRecord({ frontmatter: fm, path: doc.path });
    return record === null ? undefined : { fm, record };
  };

  const loadRecord = async (key: string, seq: number): Promise<SeedRecord | undefined> =>
    (await loadDoc(key, seq))?.record;

  /** Read the `## Seed Description` prose natively, exactly as the body-section
   * reader does (`vault.get { section }` → strip heading → parse). */
  const loadDescription = async (key: string, seq: number): Promise<string | null> => {
    const records = await client.getSections([pathOf(key, seq)], [SEED_DESCRIPTION_HEADING]);
    const record = records.length > 0 ? pathAndSections(records[0]) : null;
    const raw = record?.sections[SEED_DESCRIPTION_HEADING] ?? '';
    return parseDescriptionSection(sectionBody(raw));
  };

  /** Apply a one-plan batch of ops, failing loud if norn did not fully apply it.
   * Seed mutations are single-document and low-contention, so — unlike the node
   * write path — there is no CAS drift replay: an unconfirmed apply is terminal. */
  const apply = async (operations: MigrationOp[]): Promise<void> => {
    if (operations.length === 0) {
      return;
    }
    const plan = migrationPlan({ generator: 'mimir', operations, vaultRoot });
    const report = await client.applyPlan(plan, true);
    const root =
      isStringRecord(report) && isStringRecord(report.report) ? report.report : report;
    const outcome =
      isStringRecord(root) && typeof root.outcome === 'string' ? root.outcome : undefined;
    if (outcome !== 'applied') {
      throw validation(
        'the seed write did not complete',
        `apply outcome: ${outcome ?? 'unrecognized'}`,
      );
    }
  };

  return {
    async appendSpawned(key, seq, nodeStem) {
      const doc = await loadDoc(key, seq);
      if (doc === undefined) {
        throw validation(`no seed ${stemOf(key, seq)}`);
      }
      const { fm, record } = doc;
      if (record.spawned.includes(nodeStem)) {
        return; // idempotent — already linked
      }
      const path = pathOf(key, seq);
      const spawned = [...record.spawned, nodeStem].map(wikilink);
      const timestamp = now();
      // First link ADDs the field (absent under the omit-empty shape); later links
      // SET it, carrying the raw stored list as the CAS precondition.
      const spawnedOp =
        record.spawned.length === 0
          ? addFrontmatter(path, 'spawned', spawned)
          : setFrontmatter(path, 'spawned', spawned, fm.spawned);
      await apply([spawnedOp, setFrontmatter(path, 'updated_at', timestamp, fm.updated_at)]);
    },

    async create(input: SeedCreate) {
      const timestamp = now();
      // Stamped once, not per retry: a create-exclusive collision re-derives the
      // seq, but `created`/`updated_at` should not drift across attempts.
      const field_json = seedFieldJson({
        created: timestamp,
        key: input.key,
        kind: input.kind,
        lifecycle: 'new',
        requester: input.requester,
        spawned: [],
        title: input.title,
        updated_at: timestamp,
      });
      const body = renderSeedBody(input.description);
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
            body,
            confirm: true,
            field_json,
            parents: true,
            path: pathOf(input.key, seq),
          });
          return { key: input.key, seq };
        } catch (error) {
          // ONLY a create-exclusive path collision means a concurrent create won
          // this seq — re-derive and retry (mirrors the artifact store). Any other
          // failure rethrows: a higher-seq retry would write a duplicate.
          if (!isPathCollision(error)) {
            throw error;
          }
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : validation(`seed create kept colliding after ${String(CREATE_RETRIES)} attempts`);
    },

    async listForProject(key: string) {
      const docs = await projectDocs(key);
      return docs
        .map(toRecord)
        .filter((r): r is SeedRecord => r !== null)
        .toSorted((a, b) => a.seq - b.seq);
    },

    async load(key, seq, opts) {
      const record = await loadRecord(key, seq);
      if (record === undefined) {
        return undefined;
      }
      if (opts?.content !== true) {
        return record;
      }
      return { ...record, description: await loadDescription(key, seq) };
    },

    async patch(key, seq, patch: SeedPatch) {
      const doc = await loadDoc(key, seq);
      if (doc === undefined) {
        throw validation(`no seed ${stemOf(key, seq)}`);
      }
      const { fm, record } = doc;
      if (isTerminalSeed(record.lifecycle)) {
        throw validation(
          `seed ${stemOf(key, seq)} is ${record.lifecycle} — a terminal seed is frozen`,
          'patches (title/kind/description) apply only to a new or promoted seed',
        );
      }
      const path = pathOf(key, seq);
      const operations: MigrationOp[] = [];
      if (patch.title !== undefined) {
        operations.push(setFrontmatter(path, 'title', patch.title, fm.title));
      }
      if (patch.kind !== undefined) {
        operations.push(setFrontmatter(path, 'kind', patch.kind, fm.kind));
      }
      if (patch.description !== undefined) {
        operations.push(
          replaceSection(path, SEED_DESCRIPTION_HEADING, renderDescriptionSection(patch.description)),
        );
      }
      if (operations.length === 0) {
        return;
      }
      operations.push(setFrontmatter(path, 'updated_at', now(), fm.updated_at));
      await apply(operations);
    },

    async transition(key, seq, to: SeedLifecycle, reason: string) {
      const doc = await loadDoc(key, seq);
      if (doc === undefined) {
        throw validation(`no seed ${stemOf(key, seq)}`);
      }
      const { fm, record } = doc;
      if (!canTransitionSeed(record.lifecycle, to)) {
        throw validation(
          `a seed cannot move ${record.lifecycle} → ${to}`,
          'legal edges: new → promoted | resolved | rejected; promoted → resolved | rejected',
        );
      }
      const path = pathOf(key, seq);
      const at = now();
      // One atomic plan: the lifecycle frontmatter set + the `## History` record
      // (kind `lifecycle`, reusing the shared codec) can never diverge. Each set
      // carries the raw stored value as norn's compare-and-set precondition.
      await apply([
        setFrontmatter(path, 'lifecycle', to, fm.lifecycle),
        setFrontmatter(path, 'updated_at', at, fm.updated_at),
        appendToSection(
          path,
          HISTORY_HEADING,
          renderHistoryRecord({ at, from: record.lifecycle, kind: 'lifecycle', reason, to }),
        ),
      ]);
    },
  };
}
