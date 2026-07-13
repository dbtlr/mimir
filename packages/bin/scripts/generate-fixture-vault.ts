// Dev script, not a test body.
// oxlint-disable vitest/require-hook
/**
 * Fixture vault generator — seed a throwaway Norn-managed vault with a
 * one-of-everything set of work states, so the console's visual smokes can
 * screenshot state-dependent UI treatments without pointing at a live personal
 * vault.
 *
 * The vault is built through the SAME core mutations the product uses (create
 * verbs, lifecycle/hold transitions, dependency edges, tags, the artifact seam,
 * the seed surface) over a Norn-backed store — never raw markdown writes — so
 * every derived reading (status words, rollups, attention lanes, stale, seed
 * lanes) is exactly what the app derives at runtime.
 *
 * Backdating rides a frozen clock (`setSystemTime`, verified under plain
 * `bun run`): the "going cold" cohort is created ~20 days in the past so the
 * 14-day stale threshold fires, then the clock is restored for the fresh work.
 *
 * Run: `bun run fixtures:vault [target-path]` (default `.dev/fixture-vault`).
 * Requires `norn` on PATH.
 *
 * The {@link Board} helper carries canonical project keys and node stems through
 * every operation, matching the runtime store seam.
 */
import { setSystemTime } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { Lane, SeedLane, StatusWord, TaskStatusWord } from '@mimir/contract';

import {
  abandonTask,
  annotate,
  attachArtifact,
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  deriveSet,
  fileSeed,
  findNodeInSet,
  findProjectInSet,
  isStale,
  listSeeds,
  nodeStatusWord,
  parkTask,
  promoteSeed,
  renderId,
  seedLane,
  startTask,
  submitTask,
  tagEntities,
  transitionSeed,
  updateNode,
} from '../src/core';
import type { Store } from '../src/core';
import { attentionOf } from '../src/core/attention';
import { bunExec } from '../src/exec';
import { NornClient } from '../src/norn/client';
import { createNornWriteStore } from '../src/norn/writer';
import { converge } from '../src/vault/converge';

/** How far back the "going cold" cohort is stamped — comfortably past the 14-day
 * stale threshold so backdated in_progress/ready tasks read as stale. */
const COLD_EPOCH_DAYS = 20;

/** Default target — under the gitignored `.dev/` dev tree, isolated from any
 * real store (the same isolation `.dev/` gives the from-source dev DB). */
const DEFAULT_TARGET = join('.dev', 'fixture-vault');

/**
 * The fixture sentinel — written by this generator (and ONLY this generator)
 * into every vault it creates. The delete-and-regenerate guard keys on it:
 * a directory without the sentinel is never deleted, so pointing the script at
 * a real personal vault (which carries the standard `.mimir-vault.toml` marker
 * but never this file) refuses instead of destroying it.
 */
export const FIXTURE_SENTINEL = '.mimir-fixture-vault';

/**
 * A board-scoped verb façade over canonical project keys and node stems.
 */
class Board {
  private readonly store: Store;
  readonly key: string;

  constructor(store: Store, key: string) {
    this.store = store;
    this.key = key;
  }

  private async projectId(): Promise<string> {
    const set = deriveSet(await this.store.loadWorkingSet());
    const project = findProjectInSet(set, this.key);
    if (project === undefined) {
      throw new Error(`project ${this.key} not found`);
    }
    return project.key;
  }

  private async nodeId(stem: string): Promise<string> {
    const set = deriveSet(await this.store.loadWorkingSet());
    const node = findNodeInSet(set, stem);
    if (node === undefined) {
      throw new Error(`node ${stem} not found`);
    }
    return node.id;
  }

  private stem(seq: number): string {
    return renderId({ key: this.key, seq });
  }

  async initiative(input: {
    title: string;
    summary?: string;
    openEnded?: boolean;
  }): Promise<string> {
    const node = await createInitiative(this.store, {
      ...input,
      projectId: await this.projectId(),
    });
    return this.stem(node.seq);
  }

  async phase(parentStem: string, input: { title: string; openEnded?: boolean }): Promise<string> {
    const node = await createPhase(this.store, {
      ...input,
      parentId: await this.nodeId(parentStem),
    });
    return this.stem(node.seq);
  }

  async task(
    parentStem: string,
    input: { title: string; size?: 'small' | 'medium' | 'large'; description?: string },
  ): Promise<string> {
    const node = await createTask(this.store, {
      ...input,
      parentId: await this.nodeId(parentStem),
    });
    return this.stem(node.seq);
  }

  /** Append a freeform annotation (the core `annotate` verb) — the timeline note
   * the console's expand-in-place treatment renders. */
  async note(stem: string, content: string): Promise<void> {
    await annotate(this.store, await this.nodeId(stem), content);
  }

  /**
   * Submit-for-review metadata (MMR-256): `submitTask` itself takes only an id
   * (ADR 0001/0007) — a summary/ref rides two separate surfaces instead. The
   * `summary` field is set directly (the quick-view verdict line reads
   * `node.summary`); a matching annotation lands right after so the dossier's
   * verdict block — which derives its summary from the latest annotation
   * authored at/after the submit transition — has one to find. `externalRef`
   * is the real `external_ref` field, read by both surfaces as-is. Call after
   * `drive(stem, 'under_review')`.
   */
  async submitWith(stem: string, input: { summary: string; externalRef: string }): Promise<void> {
    const id = await this.nodeId(stem);
    await updateNode(this.store, id, { externalRef: input.externalRef, summary: input.summary });
    await annotate(this.store, id, input.summary);
  }

  /** Drive a fresh todo task to `word`; `awaiting` wires a dependency on `prereq`. */
  async drive(stem: string, word: TaskStatusWord, prereq?: string): Promise<void> {
    const id = await this.nodeId(stem);
    switch (word) {
      case 'ready': {
        return; // a fresh todo, un-held task with no unmet deps is already ready
      }
      case 'in_progress': {
        await startTask(this.store, id);
        return;
      }
      case 'under_review': {
        await startTask(this.store, id);
        await submitTask(this.store, id);
        return;
      }
      case 'done': {
        await startTask(this.store, id);
        await completeTask(this.store, id);
        return;
      }
      case 'abandoned': {
        await abandonTask(this.store, id, 'superseded by the new architecture');
        return;
      }
      case 'blocked': {
        await blockTask(this.store, id, 'waiting on an external dependency');
        return;
      }
      case 'parked': {
        await parkTask(this.store, id, 'deferred to the next milestone');
        return;
      }
      case 'awaiting': {
        if (prereq === undefined) {
          throw new Error('an awaiting task needs a prerequisite');
        }
        await depend(this.store, id, [await this.nodeId(prereq)]);
        return;
      }
    }
  }

  async tag(stem: string, tags: string[]): Promise<void> {
    await tagEntities(
      this.store,
      [{ entityId: await this.nodeId(stem), entityType: 'node' }],
      tags,
    );
  }

  async attach(input: {
    title: string;
    content: string;
    link?: string;
    tags?: string[];
  }): Promise<void> {
    await attachArtifact(this.store, {
      content: input.content,
      linkNodeIds: input.link === undefined ? [] : [await this.nodeId(input.link)],
      projectId: await this.projectId(),
      tags: input.tags ?? [],
      title: input.title,
    });
  }
}

/**
 * The Aurora status zoo (project `AUR`) — every container rollup word the
 * interpret() cascade can produce, each backed by a single leaf in the matching
 * task state (`new` is the empty-container reading, with no leaf). Adding a
 * visual state is adding a row. The `awaiting` leaf is wired to depend on the
 * `in_progress` leaf (its unsettled prerequisite) after the phases exist.
 *
 * A representative subset also carries description/annotation/review content
 * (MMR-256) so the description clamp, the timeline's expand-in-place note, and
 * the verdict block's summary/ref line are all screenshotable: `description`
 * (one long multi-paragraph, several short), `notes` (1-2 short annotations, one
 * 3+ line note), and `review` (the lone `under_review` leaf's submit summary +
 * external ref).
 */
const AURORA_ZOO: readonly {
  word: StatusWord;
  phase: string;
  task?: {
    title: string;
    leaf: TaskStatusWord;
    description?: string;
    notes?: string[];
    review?: { summary: string; externalRef: string };
  };
}[] = [
  {
    phase: 'Onboarding Flow',
    task: {
      description:
        'Replace the static onboarding splash with a three-panel carousel that walks new users through account setup, notification permissions, and the home feed. Panels advance on swipe or a 4s auto-advance timer that pauses on touch.\n\nThe carousel needs to respect reduced-motion settings (drop the auto-advance and cross-fade instead of slide) and cold-start under 400ms on a mid-tier Android device, since it sits on the critical first-run path.\n\nAnalytics: fire a `carousel_panel_viewed` event per panel with the dwell time, plus `carousel_skipped` if the user taps past before the timer completes. Design signed off on the panel copy in Figma; still waiting on final illustration exports for panel three.',
      leaf: 'in_progress',
      notes: [
        'Confirmed with design: use the existing ease-out-quad curve for the slide transition, not a new easing token.',
        'Illustration exports for panel three are still pending from brand — blocking the final QA pass.',
      ],
      title: 'Wire up the welcome carousel',
    },
    word: 'in_progress',
  },
  {
    phase: 'Push Notifications',
    task: {
      description:
        'Log a delivery receipt back to the ingestion service when a silent push actually wakes the app, so delivered can be told apart from just-sent.',
      leaf: 'under_review',
      review: {
        externalRef: 'GH-482',
        summary:
          'Delivery receipts now round-trip through the ingestion service; added retry-with-backoff for the three transient failure codes we saw in staging. Tests green, ready for a look.',
      },
      title: 'Silent push delivery receipts',
    },
    word: 'under_review',
  },
  {
    phase: 'Offline Mode',
    task: {
      description:
        'Persist the last-fetched home feed to local storage so cold app opens render instantly, then refresh in the background once connectivity is confirmed.',
      leaf: 'ready',
      notes: [
        'Talked through the caching approach with the platform team today:\n- IndexedDB for web, SQLite-backed cache for the native shell\n- 24h TTL before we treat the cached feed as stale and force a refetch\n- Falls back to the empty state (not a spinner) if both the cache and the network miss\nNo objections raised — moving ahead with this shape for the v1 cut.',
      ],
      title: 'Cache the home feed locally',
    },
    word: 'ready',
  },
  {
    phase: 'Deep Linking',
    task: { leaf: 'awaiting', title: 'Route universal links to screens' },
    word: 'awaiting',
  },
  {
    phase: 'Payments',
    task: {
      description:
        'Wire the App Store server-to-server notification webhook into the payments service so receipt validation happens without a client round-trip.',
      leaf: 'blocked',
      notes: [
        'External dependency confirmed blocking — the App Store Connect webhook config is owned by the platform-infra team; waiting on their sprint slot.',
      ],
      title: 'Integrate App Store receipts',
    },
    word: 'blocked',
  },
  {
    phase: 'Home Widgets',
    task: { leaf: 'parked', title: 'Home-screen glance widget' },
    word: 'parked',
  },
  {
    phase: 'Authentication',
    task: {
      description:
        'Add Face ID / Touch ID as an alternate to the PIN unlock screen, gated behind the existing biometric capability check.',
      leaf: 'done',
      title: 'Biometric unlock',
    },
    word: 'done',
  },
  {
    phase: 'Legacy Bridge',
    task: {
      leaf: 'abandoned',
      title: 'Port the old settings sheet',
    },
    word: 'abandoned',
  },
  { phase: 'Localization', word: 'new' }, // empty container → new
];

/** Aurora (`AUR`) — the rich board: the status zoo, the two open-ended homes,
 * the dependency chain, tags, artifacts, and the four-lane seed queue. */
async function buildAurora(store: Store): Promise<void> {
  await createProject(store, {
    description: 'Consumer mobile client — the flagship surface.',
    key: 'AUR',
    name: 'Aurora Mobile App',
    tags: ['release:v1'],
  });
  const board = new Board(store, 'AUR');

  const core = await board.initiative({
    summary: 'The everyday screens users touch first.',
    title: 'Core Experience',
  });

  // The status zoo: one phase per rollup word, each with its lone leaf. The
  // in_progress leaf (the carousel task) doubles as the dependency-chain
  // prerequisite and the tag/artifact anchor below.
  let awaitingLeaf: string | undefined;
  let carousel: string | undefined;
  let receipts: string | undefined;
  for (const row of AURORA_ZOO) {
    const phase = await board.phase(core, { title: row.phase });
    if (row.task === undefined) {
      continue; // `new` — a deliberately empty container
    }
    const task = await board.task(phase, {
      description: row.task.description,
      title: row.task.title,
    });
    if (row.task.leaf === 'awaiting') {
      awaitingLeaf = task; // wired after the loop, once its prerequisite exists
    } else {
      await board.drive(task, row.task.leaf);
    }
    for (const note of row.task.notes ?? []) {
      await board.note(task, note);
    }
    if (row.task.review !== undefined) {
      // Applied after `drive` has already carried the leaf to under_review, so
      // the submit-summary annotation lands after the submit transition.
      await board.submitWith(task, row.task.review);
    }
    if (row.task.leaf === 'in_progress') {
      carousel = task;
    }
    if (row.task.leaf === 'blocked') {
      receipts = task;
    }
  }

  // Dependency chain: the deep-linking task awaits the in-progress carousel task,
  // which becomes a blocking prerequisite (it now has an unsettled dependent).
  if (awaitingLeaf !== undefined && carousel !== undefined) {
    await board.drive(awaitingLeaf, 'awaiting', carousel);
  }

  // Two open-ended homes (MMR-204): an idle one (empty → reads `ready`, "open
  // for filing") and an active one (a live child → reads its rollup).
  await board.initiative({
    openEnded: true,
    summary: 'Standing home for finish-work — never auto-closes.',
    title: 'Polish',
  });
  const bugBash = await board.initiative({
    openEnded: true,
    summary: 'Rolling defect intake.',
    title: 'Bug Bash',
  });
  const coldStartCrash = await board.task(bugBash, {
    description:
      "Users on iOS 17 devices with low storage are hitting a crash during cold start when the asset cache directory can't be created; guard the mkdir call and fall back to in-memory caching.",
    title: 'Fix crash on cold start',
  });
  await board.drive(coldStartCrash, 'in_progress');
  await board.note(
    coldStartCrash,
    "Reproduced locally by filling the simulator's disk to <200MB free — matches the crash signature from Crashlytics.",
  );

  // Tags — a project tag (set at create) plus node tags.
  if (carousel !== undefined) {
    await board.tag(carousel, ['area:onboarding', 'release:v1']);
  }
  if (receipts !== undefined) {
    await board.tag(receipts, ['area:payments']);
  }

  // Artifacts — one attached to a task, one project-level (no links).
  await board.attach({
    content: '# Onboarding UX spec\n\nThe welcome carousel copy, timing, and analytics.\n',
    link: carousel,
    tags: ['spec'],
    title: 'Onboarding UX spec',
  });
  await board.attach({
    content: '# Q3 architecture overview\n\nModule boundaries and the sync strategy.\n',
    title: 'Q3 architecture overview',
  });

  await buildAuroraSeeds(store, board);
}

/** The Aurora seed queue — all four lanes, exercising file / promote / resolve /
 * reject. Spawned work lands under a normal "Groomed Work" phase. */
async function buildAuroraSeeds(store: Store, board: Board): Promise<void> {
  const requests = await board.initiative({ title: 'Requests' });
  const grooming = await board.phase(requests, { title: 'Groomed Work' });

  // untriaged (new)
  await fileSeed(store, {
    kind: 'feature',
    project: 'AUR',
    title: 'Dark mode across the whole app',
  });

  // promoted (in flight — spawned work outstanding)
  const rotateBug = await fileSeed(store, {
    kind: 'bug',
    project: 'AUR',
    title: 'Crash when rotating during an upload',
  });
  await promoteSeed(store, rotateBug.id, {
    parent: grooming,
    title: 'Guard the upload session across rotation',
  });

  // ready (promoted + all spawned work settled → ready to resolve)
  const hapticSeed = await fileSeed(store, {
    kind: 'feature',
    project: 'AUR',
    title: 'Add haptic feedback to primary buttons',
  });
  const haptic = await promoteSeed(store, hapticSeed.id, {
    parent: grooming,
    title: 'Add haptics to the primary button component',
  });
  if (haptic.created !== undefined) {
    await board.drive(haptic.created, 'done');
  }

  // settled — one resolved, one rejected
  const drainSeed = await fileSeed(store, {
    kind: 'bug',
    project: 'AUR',
    title: 'Investigate overnight battery drain',
  });
  await transitionSeed(store, drainSeed.id, 'resolved', 'fixed by the background-fetch throttle');
  const rewriteSeed = await fileSeed(store, {
    kind: 'idea',
    project: 'AUR',
    title: 'Rewrite the client in another framework',
  });
  await transitionSeed(store, rewriteSeed.id, 'rejected', 'not worth the migration cost right now');
}

/** Beacon (`BCN`) — the going-cold board, built under a frozen past clock so its
 * in_progress and ready leaves read as stale. Its top attention lane is `live`. */
async function buildBeaconCold(store: Store): Promise<void> {
  await createProject(store, {
    description: 'Event ingestion and analytics platform.',
    key: 'BCN',
    name: 'Beacon Analytics',
  });
  const board = new Board(store, 'BCN');
  const ingestion = await board.initiative({ title: 'Ingestion Pipeline' });
  const stream = await board.phase(ingestion, { title: 'Stream Processing' });

  const backfill = await board.task(stream, {
    size: 'large',
    title: 'Backfill the event schema to v2',
  });
  await board.drive(backfill, 'in_progress'); // stale in_progress once the clock restores
  await board.task(stream, { title: 'Partition the cold store by tenant' }); // stale ready (untouched todo)
}

/** Cirrus (`CIR`) — the needs-unsticking board: a merge-engine phase whose only
 * live leaf is blocked, and that leaf is orphaned (its siblings are terminal). */
async function buildCirrus(store: Store): Promise<void> {
  await createProject(store, {
    description: 'Cross-device sync engine.',
    key: 'CIR',
    name: 'Cirrus Sync',
  });
  const board = new Board(store, 'CIR');
  const conflict = await board.initiative({ title: 'Conflict Resolution' });
  const engine = await board.phase(conflict, { title: 'Merge Engine' });

  await board.drive(await board.task(engine, { title: 'Three-way merge of diffs' }), 'done');
  await board.drive(await board.task(engine, { title: 'Resolve tombstone races' }), 'abandoned');
  // The lone live sibling among terminals → orphaned (normal parent).
  await board.drive(await board.task(engine, { title: 'Handle wall-clock skew' }), 'blocked');
}

/** Delta (`DLT`) — the at-rest board, and the orphan-mute case: a parked leaf
 * whose sibling is done, but under an open-ended home, so it is NOT orphaned. */
async function buildDelta(store: Store): Promise<void> {
  await createProject(store, {
    description: 'Long-term archival records service.',
    key: 'DLT',
    name: 'Delta Records',
  });
  const board = new Board(store, 'DLT');
  const backlog = await board.initiative({
    openEnded: true,
    summary: 'Standing home — filed work outliving its siblings is normal here.',
    title: 'Backlog',
  });
  await board.drive(await board.task(backlog, { title: 'Archive the tape imports' }), 'done');
  await board.drive(await board.task(backlog, { title: 'Vendor CSV adapter' }), 'parked'); // orphan-muted
}

export type FixtureSummary = {
  vaultPath: string;
  projects: string[];
  /** Every node's Status word (leaf + container rollup) → count across the vault. */
  statusWords: Partial<Record<StatusWord, number>>;
  /** Per-project attention lane → project count. */
  lanes: Partial<Record<Lane, number>>;
  /** Seed lane → seed count. */
  seedLanes: Partial<Record<SeedLane, number>>;
  /** Leaf tasks whose Status word reads stale (going cold). */
  stale: number;
  /** Attached artifacts across the vault. */
  artifacts: number;
};

/**
 * Guard the target. Delete-and-regenerate is allowed ONLY for a directory this
 * generator itself created (it carries {@link FIXTURE_SENTINEL}); an absent
 * path and an empty directory proceed untouched. Anything else refuses — a
 * regular file, a non-empty directory, and in particular a REAL mimir vault
 * (which carries the standard marker but never the fixture sentinel) — so the
 * script can never destroy a personal vault.
 */
function prepareTarget(target: string): void {
  if (!existsSync(target)) {
    return; // absent — converge creates it
  }
  if (!statSync(target).isDirectory()) {
    throw new Error(
      `${target} is a file, not a directory — refusing to use it as the fixture vault target.`,
    );
  }
  if (existsSync(join(target, FIXTURE_SENTINEL))) {
    rmSync(target, { force: true, recursive: true }); // a throwaway we made — regenerate
    return;
  }
  if (readdirSync(target).length === 0) {
    return; // empty — nothing to delete; converge scaffolds in place
  }
  throw new Error(
    `${target} is not empty and is not a generated fixture vault (no ${FIXTURE_SENTINEL} sentinel) — ` +
      'refusing to touch it. Point the generator at an absent/empty path or a previously generated fixture vault.',
  );
}

/**
 * Freeze the process clock `days` in the past and PROVE the freeze took effect
 * — `setSystemTime` is a `bun:test` API exercised here under plain `bun run`,
 * so if a future Bun makes it a no-op outside the test runner, the going-cold
 * cohort would silently ship fresh and defeat the fixture's purpose. Fail loud
 * instead.
 */
function freezeClockDaysAgo(days: number): void {
  const realNow = Date.now();
  const offsetMs = days * 24 * 60 * 60 * 1000;
  setSystemTime(new Date(realNow - offsetMs));
  const observed = realNow - Date.now();
  // The frozen clock should read ~offsetMs behind the captured real time; allow
  // a generous minute of slack for the calls themselves.
  if (Math.abs(observed - offsetMs) > 60_000) {
    setSystemTime();
    throw new Error(
      'setSystemTime did not take effect under `bun run` — the backdated (going-cold) ' +
        'cohort cannot be generated. Check the Bun version.',
    );
  }
}

/**
 * Generate the fixture vault at `target` (created fresh; a previously generated
 * fixture vault is regenerated). Returns a coverage summary read back through
 * the derivation surface. Exported so the integration test drives the same
 * entry point the CLI does.
 */
export async function generateFixtureVault(target: string): Promise<FixtureSummary> {
  const absTarget = isAbsolute(target) ? target : resolve(target);
  prepareTarget(absTarget);
  mkdirSync(absTarget, { recursive: true });
  await converge(absTarget, { allowCreate: true, exec: bunExec });
  // Mark the vault as a generated throwaway IMMEDIATELY, so even a crashed
  // half-built run leaves a directory the next run may regenerate.
  writeFileSync(
    join(absTarget, FIXTURE_SENTINEL),
    'Generated fixture vault (MMR-255) — safe to delete or regenerate via `bun run fixtures:vault`.\n',
  );

  const client = new NornClient({ vaultPath: absTarget });
  try {
    const store = createNornWriteStore(client, absTarget);

    // Epoch 1: the going-cold cohort, under a frozen (and verified) past clock.
    freezeClockDaysAgo(COLD_EPOCH_DAYS);
    await buildBeaconCold(store);
    setSystemTime(); // restore the real clock for every fresh cohort

    // Epoch 2: the fresh boards.
    await buildAurora(store);
    await buildCirrus(store);
    await buildDelta(store);

    return await summarize(store, absTarget);
  } finally {
    setSystemTime(); // belt-and-suspenders: never leave the process clock frozen
    await client.close();
  }
}

/** Read the whole vault back and compute the coverage summary via derivation. */
async function summarize(store: Store, vaultPath: string): Promise<FixtureSummary> {
  const ws = await store.loadWorkingSet();
  const set = deriveSet(ws);

  const statusWords: Partial<Record<StatusWord, number>> = {};
  let stale = 0;
  for (const node of ws.nodes) {
    const word = nodeStatusWord(set, node);
    statusWords[word] = (statusWords[word] ?? 0) + 1;
    if (node.type === 'task' && isStale(set, node)) {
      stale += 1;
    }
  }

  const lanes: Partial<Record<Lane, number>> = {};
  for (const project of ws.projects) {
    const { lane } = attentionOf(set, project);
    lanes[lane] = (lanes[lane] ?? 0) + 1;
  }

  const seedViews = await listSeeds(store, { status: 'all' });
  const seedLanes: Partial<Record<SeedLane, number>> = {};
  for (const view of seedViews) {
    const lane = seedLane(view);
    seedLanes[lane] = (seedLanes[lane] ?? 0) + 1;
  }

  let artifacts = 0;
  for (const project of ws.projects) {
    artifacts += (await store.artifacts.listForProject(project.key)).length;
  }

  return {
    artifacts,
    lanes,
    projects: ws.projects.map((p) => p.key).toSorted(),
    seedLanes,
    stale,
    statusWords,
    vaultPath,
  };
}

// ── CLI entry ────────────────────────────────────────────────────────────────

/** A `key=count` line, sorted by key — one summary row's value. */
function kvLine(rec: Partial<Record<string, number>>): string {
  return Object.entries(rec)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('  ');
}

/** Render the summary as an aligned, human-readable block. */
function formatSummary(s: FixtureSummary): string {
  return [
    `vault:        ${s.vaultPath}`,
    `projects:     ${s.projects.join(', ')}`,
    `status words: ${kvLine(s.statusWords)}`,
    `attention:    ${kvLine(s.lanes)}`,
    `seed lanes:   ${kvLine(s.seedLanes)}`,
    `stale tasks:  ${String(s.stale)}`,
    `artifacts:    ${String(s.artifacts)}`,
  ].join('\n');
}

async function main(): Promise<number> {
  if (Bun.which('norn') === null) {
    console.error('✗ fixtures:vault needs `norn` on PATH — install it and retry.');
    return 1;
  }
  const arg = Bun.argv[2];
  const target = arg !== undefined && arg.trim() !== '' ? arg : DEFAULT_TARGET;
  const summary = await generateFixtureVault(target);
  console.log('fixture vault generated:\n');
  console.log(formatSummary(summary));
  if (summary.stale === 0) {
    console.error(
      '\n✗ no stale tasks manifested — the backdated (going-cold) cohort did not land; ' +
        'the fixture is incomplete.',
    );
    return 1;
  }
  console.log('\nsmoke it:');
  console.log(`  MIMIR_VAULT=${summary.vaultPath} \\`);
  console.log('    bun run packages/bin/src/main.ts serve');
  return 0;
}

// Run only as a script, never on import (the integration test imports the fn).
if (import.meta.main) {
  process.exitCode = await main();
}
