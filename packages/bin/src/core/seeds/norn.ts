import { SEED_KIND_VALUES, SEED_LIFECYCLE_VALUES } from '@mimir/contract';
import type { SeedKind, SeedLifecycle } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import type { NornClient, NornDocument } from '../../norn/client';
import { isPathCollision } from '../../norn/client';
import {
  collapse,
  isStringRecord,
  linkStems,
  pathAndSections,
  stemOf as stemFromPath,
} from '../../norn/decode';
import type { MigrationOp } from '../../norn/plan';
import {
  addFrontmatter,
  appendToSection,
  migrationPlan,
  replaceSection,
  setFrontmatter,
} from '../../norn/plan';
import { notFound, validation } from '../errors';
import {
  HISTORY_HEADING,
  parseDescriptionSection,
  parseHistorySection,
  renderDescriptionSection,
  renderHistoryRecord,
  renderSeedBody,
  SEED_DESCRIPTION_HEADING,
  sectionBody,
  sliceSection,
} from '../history-codec';
import { parseSeedRef, renderSeedRef, wikilink } from '../ids';
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

const stemOf = (key: string, seq: number): string => renderSeedRef({ key, seq });
const pathOf = (key: string, seq: number): string => `${key}/seeds/${stemOf(key, seq)}.md`;

/** Parse `KEY-sN` out of a vault seed path; null for non-seed paths — the canonical
 * grammar parser over the document stem (store-norn's seed read does the same). */
function seqFromPath(path: string): { key: string; seq: number } | null {
  return parseSeedRef(stemFromPath(path));
}

/** Narrow a raw frontmatter value to a member of a closed seed enum; null when it is
 * absent, non-string, or foreign — kind and lifecycle share the one guard. */
function narrowEnum<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === 'string' && isMember(value, values) ? value : null;
}

/** Choose add vs set for the `spawned` field on the RAW field PRESENCE, not the
 * decoded length (matching writer.ts's `field in rawFm`): an absent field is ADDed;
 * a present one — including a hand-written empty `spawned: []` — is SET, carrying the
 * raw stored value as the CAS precondition. norn refuses to add a present field, so
 * keying on the decoded (empty) length would wrongly ADD and be refused. */
function spawnedFieldOp(path: string, fm: Record<string, unknown>, spawned: string[]): MigrationOp {
  const links = spawned.map(wikilink);
  return 'spawned' in fm
    ? setFrontmatter(path, 'spawned', links, fm.spawned)
    : addFrontmatter(path, 'spawned', links);
}

/** Order seed records by `(key, seq)` — the deterministic whole-vault listing order. */
function byKeyThenSeq(a: SeedRecord, b: SeedRecord): number {
  if (a.key !== b.key) {
    return a.key < b.key ? -1 : 1;
  }
  return a.seq - b.seq;
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
  const kind = narrowEnum(fm.kind, SEED_KIND_VALUES);
  const lifecycle = narrowEnum(fm.lifecycle, SEED_LIFECYCLE_VALUES);
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
  const seedDocs = async (): Promise<NornDocument[]> =>
    client.find({ eq: ['type:seed'], no_limit: true });

  /** Every seed-shaped physical path, regardless of readable frontmatter. Seq
   * allocation follows path identity so an untyped/foreign owner still occupies
   * its number. */
  const projectDocs = async (key: string): Promise<NornDocument[]> =>
    (await client.find({ no_limit: true, path: ['**/*-s*.md'] })).filter(
      (doc) => seqFromPath(doc.path)?.key === key,
    );

  const resolvedDocs = async (
    stems: readonly string[],
    withBody = false,
  ): Promise<NornDocument[]> => {
    if (stems.length === 0) {
      return [];
    }
    const records = await client.get(
      [...new Set(stems)],
      withBody ? '.frontmatter,.body' : '.frontmatter',
    );
    return records.flatMap((record) =>
      isStringRecord(record) && typeof record.path === 'string'
        ? [{ ...record, path: record.path }]
        : [],
    );
  };

  /** Validator parity for listings: resolve the typed candidates by bare stem in
   * one batch, then exclude every identity with more than one physical target —
   * including parse-failed, untyped, or foreign-type colliders. */
  const survivingRecords = async (docs: readonly NornDocument[]): Promise<SeedRecord[]> => {
    const records = docs.map(toRecord).filter((record): record is SeedRecord => record !== null);
    const resolved = await resolvedDocs(records.map((record) => stemOf(record.key, record.seq)));
    const counts = new Map<string, number>();
    for (const doc of resolved) {
      const identity = seqFromPath(doc.path);
      if (identity !== null) {
        const stem = stemOf(identity.key, identity.seq);
        counts.set(stem, (counts.get(stem) ?? 0) + 1);
      }
    }
    return records.filter((record) => counts.get(stemOf(record.key, record.seq)) === 1);
  };

  // The typed record plus the RAW frontmatter — the mutation path needs the raw
  // stored values as norn's `expected_old_value` compare-and-set precondition
  // (an omitted precondition asserts the field is ABSENT, so overwriting a present
  // field must carry its current value, exactly as the node write path does).
  const loadDoc = async (
    key: string,
    seq: number,
    withBody = false,
  ): Promise<
    { record: SeedRecord; fm: Record<string, unknown>; path: string; body?: string } | undefined
  > => {
    // Bare-stem resolution is the latest point Norn can enforce uniqueness. The
    // resulting migration must still address `doc.path`: Norn 0.47 apply rejects
    // logical stems as unknown paths, so a second client can introduce a collider
    // after this read and before apply. Closing that window requires an atomic
    // logical-identity precondition in Norn, not another non-atomic adapter read.
    const docs = (await resolvedDocs([stemOf(key, seq)], withBody)).filter((doc) => {
      const identity = seqFromPath(doc.path);
      return identity?.key === key && identity.seq === seq;
    });
    if (docs.length !== 1) {
      return undefined;
    }
    const doc = docs[0];
    if (doc === undefined) {
      return undefined;
    }
    const fm = isStringRecord(doc.frontmatter) ? doc.frontmatter : {};
    const record = toRecord({ frontmatter: fm, path: doc.path });
    return record === null
      ? undefined
      : {
          fm,
          path: doc.path,
          record,
          ...(typeof doc.body === 'string' ? { body: doc.body } : {}),
        };
  };

  const loadRecord = async (key: string, seq: number): Promise<SeedRecord | undefined> =>
    (await loadDoc(key, seq))?.record;

  /** The record PLUS its `## Seed Description` prose in one bare-stem resolution
   * with `.body`: establish unique physical ownership, build the record from the
   * frontmatter, and slice + parse the description locally. The targeted read also
   * returns the record even when
   * the description heading is ambiguous — the seed still loads, and `mimir doctor`
   * surfaces the duplicate (MMR-239). */
  const loadWithContent = async (
    key: string,
    seq: number,
  ): Promise<(SeedRecord & { description: string | null }) | undefined> => {
    const doc = await loadDoc(key, seq, true);
    if (doc === undefined) {
      return undefined;
    }
    const description = parseDescriptionSection(
      sectionBody(sliceSection(doc.body ?? '', SEED_DESCRIPTION_HEADING)),
    );
    return { ...doc.record, description };
  };

  /** Apply a one-plan batch of ops, returning norn's `outcome` — `'applied'` on
   * success, `'refused'` on a compare-and-set precondition miss (a concurrent
   * write moved the doc), else `'failed'`/`'unrecognized'`. The caller decides
   * whether an outcome is retryable ({@link germinate}) or terminal ({@link apply}). */
  const applyOutcome = async (operations: MigrationOp[]): Promise<string> => {
    const plan = migrationPlan({ generator: 'mimir', operations, vaultRoot });
    const report = await client.applyPlan(plan, true);
    const root = isStringRecord(report) && isStringRecord(report.report) ? report.report : report;
    return isStringRecord(root) && typeof root.outcome === 'string' ? root.outcome : 'unrecognized';
  };

  /** Apply a one-plan batch of ops, failing loud if norn did not fully apply it.
   * The single-shot path (create/patch/transition): an unconfirmed apply is
   * terminal, with no drift replay. */
  const apply = async (operations: MigrationOp[]): Promise<void> => {
    if (operations.length === 0) {
      return;
    }
    const outcome = await applyOutcome(operations);
    if (outcome !== 'applied') {
      throw validation('the seed write did not complete', `apply outcome: ${outcome}`);
    }
  };

  return {
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
          // `vault.new` is exclusive only on this physical destination. A second
          // client can concurrently create the same stem elsewhere; Norn needs a
          // stem reservation/unique-create primitive to make that race atomic.
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

    async germinate(key, seq, nodeStem) {
      // Up to two attempts: on a compare-and-set refusal (a concurrent write moved
      // the doc) re-read once and retry against the now-current frontmatter (the
      // store contract prescribes caller retry). A second refusal rethrows.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const doc = await loadDoc(key, seq);
        if (doc === undefined) {
          throw notFound(`no seed ${stemOf(key, seq)}`);
        }
        const { fm, record } = doc;
        if (isTerminalSeed(record.lifecycle)) {
          throw validation(
            `seed ${stemOf(key, seq)} is ${record.lifecycle} — a terminal seed is frozen`,
            'promote applies only to a new or promoted seed',
          );
        }
        const alreadyLinked = record.spawned.includes(nodeStem);
        const needsPromote = record.lifecycle === 'new';
        // Idempotent: the stem is already linked AND the seed is already promoted →
        // nothing to do (a retried promote cannot double-record).
        if (alreadyLinked && !needsPromote) {
          return;
        }
        const path = doc.path;
        const at = now();
        // ONE plan: the (conditional) spawned append + the (conditional) lifecycle
        // set with its History record + one updated_at — so the link and the
        // lifecycle move can never diverge.
        const operations: MigrationOp[] = [];
        if (!alreadyLinked) {
          operations.push(spawnedFieldOp(path, fm, [...record.spawned, nodeStem]));
        }
        if (needsPromote) {
          operations.push(
            setFrontmatter(path, 'lifecycle', 'promoted', fm.lifecycle),
            appendToSection(
              path,
              HISTORY_HEADING,
              renderHistoryRecord({
                at,
                from: record.lifecycle,
                kind: 'lifecycle',
                reason: `promoted — spawned ${nodeStem}`,
                to: 'promoted',
              }),
            ),
          );
        }
        operations.push(setFrontmatter(path, 'updated_at', at, fm.updated_at));
        const outcome = await applyOutcome(operations);
        if (outcome === 'applied') {
          return;
        }
        if (outcome !== 'refused' || attempt === 1) {
          throw validation('the seed write did not complete', `apply outcome: ${outcome}`);
        }
      }
    },

    async listAll() {
      // One `type:seed` find over the whole vault (E1) — the caller filters to the
      // boards it wants. Ordered by (key, seq) for determinism; the listing re-sorts.
      const docs = await seedDocs();
      return (await survivingRecords(docs)).toSorted(byKeyThenSeq);
    },

    async listForProject(key: string) {
      const docs = await seedDocs();
      return (await survivingRecords(docs))
        .filter((record) => record.key === key)
        .toSorted((a, b) => a.seq - b.seq);
    },

    async load(key, seq, opts) {
      // Metadata-only is one bare-stem resolution; content opts into `.body` on
      // that same targeted read, carrying both record and description prose.
      return opts?.content === true ? loadWithContent(key, seq) : loadRecord(key, seq);
    },

    async loadDescriptions(refs) {
      // ONE native `vault.get { section }` over every requested seed path (MMR-263):
      // the whole live queue's `## Seed Description` prose in a single round-trip, the
      // derive-at-read lede source. An empty request short-circuits (an empty target
      // list to vault.get is unverified behavior, matching the doctor/triage probes).
      const out = new Map<string, string | null>();
      if (refs.length === 0) {
        return out;
      }
      const wanted = refs.map(({ key, seq }) => stemOf(key, seq));
      const docs = await resolvedDocs(wanted);
      const counts = new Map<string, number>();
      for (const doc of docs) {
        const identity = seqFromPath(doc.path);
        if (identity !== null) {
          const stem = stemOf(identity.key, identity.seq);
          counts.set(stem, (counts.get(stem) ?? 0) + 1);
        }
      }
      const paths = docs.flatMap((doc) => {
        const identity = seqFromPath(doc.path);
        return identity !== null && counts.get(stemOf(identity.key, identity.seq)) === 1
          ? [doc.path]
          : [];
      });
      if (paths.length === 0) {
        return out;
      }
      const records = await client.getSections(paths, [SEED_DESCRIPTION_HEADING]);
      for (const raw of records) {
        const record = pathAndSections(raw);
        if (record === null) {
          continue;
        }
        const identity = seqFromPath(record.path);
        if (identity === null) {
          continue;
        }
        // A warn-omitted/absent section reads as empty prose → null (no lede).
        const description = parseDescriptionSection(
          sectionBody(record.sections[SEED_DESCRIPTION_HEADING] ?? ''),
        );
        out.set(stemOf(identity.key, identity.seq), description);
      }
      return out;
    },

    async loadHistory(key, seq) {
      // Read the seed's `## History` natively (`vault.get { section }`), exactly as
      // the node body-section store does — one round-trip, sliced with norn's edit
      // boundary semantics. Target the unique physical path resolved above, not
      // the bare stem, so relocated owners work and collisions remain absent. An
      // absent doc yields no record → undefined; a warn-omitted/empty section → [].
      const doc = await loadDoc(key, seq);
      if (doc === undefined) {
        return undefined;
      }
      const records = await client.getSections([doc.path], [HISTORY_HEADING]);
      const record = records.length > 0 ? pathAndSections(records[0]) : null;
      if (record === null) {
        return undefined;
      }
      return parseHistorySection(sectionBody(record.sections[HISTORY_HEADING] ?? ''));
    },

    async patch(key, seq, patch: SeedPatch) {
      const doc = await loadDoc(key, seq);
      if (doc === undefined) {
        throw notFound(`no seed ${stemOf(key, seq)}`);
      }
      const { fm, record } = doc;
      if (isTerminalSeed(record.lifecycle)) {
        throw validation(
          `seed ${stemOf(key, seq)} is ${record.lifecycle} — a terminal seed is frozen`,
          'patches (title/kind/description) apply only to a new or promoted seed',
        );
      }
      const path = doc.path;
      const operations: MigrationOp[] = [];
      if (patch.title !== undefined) {
        operations.push(setFrontmatter(path, 'title', patch.title, fm.title));
      }
      if (patch.kind !== undefined) {
        operations.push(setFrontmatter(path, 'kind', patch.kind, fm.kind));
      }
      if (patch.description !== undefined) {
        operations.push(
          replaceSection(
            path,
            SEED_DESCRIPTION_HEADING,
            renderDescriptionSection(patch.description),
          ),
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
        throw notFound(`no seed ${stemOf(key, seq)}`);
      }
      const { fm, record } = doc;
      if (!canTransitionSeed(record.lifecycle, to)) {
        throw validation(
          `a seed cannot move ${record.lifecycle} → ${to}`,
          'legal edges: new → promoted | resolved | rejected; promoted → resolved | rejected',
        );
      }
      const path = doc.path;
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
