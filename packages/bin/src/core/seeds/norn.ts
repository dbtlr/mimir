import { SEED_KIND_VALUES, SEED_LIFECYCLE_VALUES } from '@mimir/contract';
import type { SeedKind, SeedLifecycle } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import type { NornClient, NornDocument } from '../../norn/client';
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
  createDocument,
  migrationPlan,
  replaceSection,
  SEQ_TOKEN,
  setFrontmatter,
} from '../../norn/plan';
import { invariant, notFound, validation } from '../errors';
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
 * - **Seq allocation rides the `{{seq}}` token** (MMR-196), mirroring the
 *   artifact store and the node write path: a create is one `create_document`
 *   op whose path carries a trailing `KEY-s{{seq}}` token that Norn resolves to
 *   the next free sibling sequence at apply time — the single allocation
 *   authority. No client-side `max(seq)+1`, no create-exclusive retry; the apply
 *   report echoes the resolved `KEY-sN` stem.
 * - **Section-touching mutations ride `vault.apply`** (the same atomic plan
 *   machinery the node write path uses): a lifecycle transition is one plan
 *   carrying the `lifecycle` set + the `## History` append, so the frontmatter
 *   and the log can never diverge. Frontmatter-only edits ride the same plan.
 * - **The lifecycle machine and terminal-freeze live here** (the store/mutation
 *   layer): `patch` refuses a terminal seed, `transition` refuses an illegal edge.
 */

const stemOf = (key: string, seq: number): string => renderSeedRef({ key, seq });

/** The `create_document` path template for a fresh seed — the trailing
 * `KEY-s{{seq}}` token is Norn's per-directory next-free allocation handle
 * (resolved at apply time), mirroring the node write path's `KEY-{{seq}}`. */
const createTemplate = (key: string): string => `${key}/seeds/${key}-s${SEQ_TOKEN}.md`;

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
  if (identity === null || fm === undefined || fm.type !== 'seed') {
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
 * The seed frontmatter record handed to `create_document.new_value` —
 * `requester` and `spawned` are omitted when empty so a seed carries only the
 * fields it has, matching the omit-empty node/artifact shape. `project` and
 * `requester` are wikilinks (Norn collapses brackets in matching); `spawned` is
 * a wikilink list.
 */
function seedFrontmatter(fields: {
  key: string;
  title: string;
  kind: SeedKind;
  lifecycle: SeedLifecycle;
  requester: string | null;
  spawned: string[];
  created: string;
  updated_at: string;
}): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    created: fields.created,
    kind: fields.kind,
    lifecycle: fields.lifecycle,
    project: wikilink(fields.key),
    title: fields.title,
    type: 'seed',
    updated_at: fields.updated_at,
  };
  if (fields.requester !== null) {
    fm.requester = wikilink(fields.requester);
  }
  if (fields.spawned.length > 0) {
    fm.spawned = fields.spawned.map(wikilink);
  }
  return fm;
}

export function createNornSeedStore(client: NornClient, vaultRoot: string): SeedStore {
  const seedDocs = async (): Promise<NornDocument[]> =>
    client.find({ eq: ['type:seed'], no_limit: true });

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
  const survivingRecords = async (
    docs: readonly NornDocument[],
    project?: string,
  ): Promise<SeedRecord[]> => {
    const candidateStems = docs.flatMap((doc) => {
      const identity = seqFromPath(doc.path);
      return identity !== null && (project === undefined || identity.key === project)
        ? [stemOf(identity.key, identity.seq)]
        : [];
    });
    const resolved = await resolvedDocs(candidateStems);
    const counts = new Map<string, number>();
    for (const doc of resolved) {
      const identity = seqFromPath(doc.path);
      if (identity !== null) {
        const stem = stemOf(identity.key, identity.seq);
        counts.set(stem, (counts.get(stem) ?? 0) + 1);
      }
    }
    return resolved
      .map(toRecord)
      .filter((record): record is SeedRecord => record !== null)
      .filter((record) => project === undefined || record.key === project)
      .filter((record) => counts.get(stemOf(record.key, record.seq)) === 1);
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
      // One `create_document` whose path carries the `KEY-s{{seq}}` token — Norn
      // allocates the next free per-directory sequence at apply time (the single
      // allocation authority), so there is no derived `max(seq)+1` and no
      // create-exclusive retry. The apply report echoes the resolved `KEY-sN`.
      const frontmatter = seedFrontmatter({
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
      const plan = migrationPlan({
        generator: 'mimir',
        operations: [createDocument(createTemplate(input.key), frontmatter, body)],
        vaultRoot,
      });
      const report = await client.applyPlan(plan, true);
      const root = isStringRecord(report) && isStringRecord(report.report) ? report.report : report;
      const outcome =
        isStringRecord(root) && typeof root.outcome === 'string' ? root.outcome : 'unrecognized';
      const operations =
        isStringRecord(root) && Array.isArray(root.operations) ? root.operations : [];
      const op = operations.find(
        (o): o is Record<string, unknown> => isStringRecord(o) && o.kind === 'create_document',
      );
      if (outcome !== 'applied' || op === undefined || typeof op.stem !== 'string') {
        const error = op !== undefined && isStringRecord(op.error) ? op.error : undefined;
        const code = typeof error?.code === 'string' ? error.code : undefined;
        const message = typeof error?.message === 'string' ? error.message : undefined;
        throw validation(
          'the seed create did not complete',
          `apply outcome: ${outcome}${code !== undefined && message !== undefined ? ` — ${code}: ${message}` : ''}`,
        );
      }
      const ref = parseSeedRef(op.stem);
      if (ref === null || ref.key !== input.key) {
        throw invariant(`a created seed resolved to an unexpected stem: ${op.stem}`);
      }
      return { key: input.key, seq: ref.seq };
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
      return (await survivingRecords(docs, key)).toSorted((a, b) => a.seq - b.seq);
    },

    async load(key, seq, opts) {
      // Metadata-only is one bare-stem resolution; content opts into `.body` on
      // that same targeted read, carrying both record and description prose.
      return opts?.content === true ? loadWithContent(key, seq) : loadRecord(key, seq);
    },

    async loadDescriptions(refs) {
      // One logical-stem section read over the requested seed identities (MMR-263).
      // Frontmatter, sections, and section failures come from that same cache
      // refresh, so foreign owners and heading-less colliders both fail closed.
      const out = new Map<string, string | null>();
      if (refs.length === 0) {
        return out;
      }
      const wanted = refs.map(({ key, seq }) => stemOf(key, seq));
      const result = await client.getSectionsResult(
        wanted,
        [SEED_DESCRIPTION_HEADING],
        '.frontmatter',
      );
      const owners = new Map<string, Set<string>>();
      const records = new Map<string, ReturnType<typeof pathAndSections>>();
      for (const raw of result.records) {
        const doc = pathAndSections(raw);
        if (doc === null) {
          continue;
        }
        const identity = seqFromPath(doc.path);
        if (identity !== null) {
          const stem = stemOf(identity.key, identity.seq);
          owners.set(stem, new Set([...(owners.get(stem) ?? []), doc.path]));
          const frontmatter =
            isStringRecord(raw) && isStringRecord(raw.frontmatter) ? raw.frontmatter : undefined;
          if (toRecord({ frontmatter, path: doc.path }) !== null) {
            records.set(stem, doc);
          }
        }
      }
      for (const path of result.sectionFailures) {
        const identity = seqFromPath(path);
        if (identity === null) {
          continue;
        }
        const stem = stemOf(identity.key, identity.seq);
        owners.set(stem, new Set([...(owners.get(stem) ?? []), path]));
      }
      for (const stem of new Set(wanted)) {
        const record = records.get(stem);
        if (owners.get(stem)?.size !== 1 || record === null || record === undefined) {
          continue;
        }
        const description = parseDescriptionSection(
          sectionBody(record.sections[SEED_DESCRIPTION_HEADING] ?? ''),
        );
        out.set(stem, description);
      }
      return out;
    },

    async loadHistory(key, seq) {
      // One logical-stem operation returns both successful records and failed
      // physical owners plus frontmatter. Requiring one valid seed owner closes
      // the pre-read/section gap while preserving relocated seeds.
      const stem = stemOf(key, seq);
      const result = await client.getSectionsResult([stem], [HISTORY_HEADING], '.frontmatter');
      const sectionRecords = result.records
        .map(pathAndSections)
        .filter((record): record is NonNullable<typeof record> => record !== null)
        .filter((record) => seqFromPath(record.path)?.key === key)
        .filter((record) => seqFromPath(record.path)?.seq === seq);
      const records = result.records.flatMap((raw) => {
        const record = pathAndSections(raw);
        const frontmatter =
          isStringRecord(raw) && isStringRecord(raw.frontmatter) ? raw.frontmatter : undefined;
        return record !== null && toRecord({ frontmatter, path: record.path }) !== null
          ? [record]
          : [];
      });
      const owners = new Set([
        ...sectionRecords.map((record) => record.path),
        ...result.sectionFailures.filter((path) => {
          const identity = seqFromPath(path);
          return identity?.key === key && identity.seq === seq;
        }),
      ]);
      if (owners.size !== 1 || records.length !== 1) {
        return undefined;
      }
      const record = records[0];
      if (record === undefined) {
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
