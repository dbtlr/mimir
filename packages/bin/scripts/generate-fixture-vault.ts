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
 * Identity note: the Norn store mints synthetic numeric ids per read and shifts
 * them as documents are added, and a project create echoes only a provisional
 * id — so every numeric id is re-resolved from a fresh working set by its stable
 * `KEY-seq` stem right before use (the {@link Board} helper). This mirrors how the
 * intent layer resolves ids against a freshly loaded snapshot.
 */
import { setSystemTime } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { Lane, SeedLane, StatusWord } from '@mimir/contract';

import {
  abandonTask,
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
} from '../src/core';
import type { Store } from '../src/core';
import { attentionOf } from '../src/core/attention';
import { bunExec } from '../src/exec';
import { NornClient } from '../src/norn/client';
import { createNornWriteStore } from '../src/norn/writer';
import { converge } from '../src/vault/converge';
import { MARKER_FILE } from '../src/vault/schema';

/** How far back the "going cold" cohort is stamped — comfortably past the 14-day
 * stale threshold so backdated in_progress/ready tasks read as stale. */
const COLD_EPOCH_DAYS = 20;

/** Default target — under the gitignored `.dev/` dev tree, isolated from any
 * real store (the same isolation `.dev/` gives the from-source dev DB). */
const DEFAULT_TARGET = join('.dev', 'fixture-vault');

/** Finder droppings that don't count against an "empty" directory. */
const IGNORABLE = new Set(['.DS_Store']);

/** A leaf task's target Status word and the verb recipe that manufactures it.
 * `awaiting` needs an unsettled prerequisite; every other word is a self-contained
 * sequence over a fresh todo task. */
type LeafWord =
  | 'ready'
  | 'awaiting'
  | 'blocked'
  | 'parked'
  | 'in_progress'
  | 'under_review'
  | 'done'
  | 'abandoned';

/**
 * A board-scoped verb façade. Every method re-resolves the numeric ids it needs
 * from a fresh working set by stable `KEY-seq` stem, so ids that shift as the
 * vault grows never leak between transactions. Create verbs return the new node's
 * stem; state verbs take one.
 */
class Board {
  private readonly store: Store;
  readonly key: string;

  constructor(store: Store, key: string) {
    this.store = store;
    this.key = key;
  }

  private async projectId(): Promise<number> {
    const ws = await this.store.loadWorkingSet();
    const project = ws.projects.find((p) => p.key === this.key);
    if (project === undefined) {
      throw new Error(`project ${this.key} not found`);
    }
    return project.id;
  }

  private async nodeId(stem: string): Promise<number> {
    const ws = await this.store.loadWorkingSet();
    const set = deriveSet(ws);
    for (const node of ws.nodes) {
      const key = set.keyByProjectId.get(node.project_id);
      if (key !== undefined && renderId({ key, seq: node.seq }) === stem) {
        return node.id;
      }
    }
    throw new Error(`node ${stem} not found`);
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
    input: { title: string; size?: 'small' | 'medium' | 'large' },
  ): Promise<string> {
    const node = await createTask(this.store, {
      ...input,
      parentId: await this.nodeId(parentStem),
    });
    return this.stem(node.seq);
  }

  /** Drive a fresh todo task to `word`; `awaiting` wires a dependency on `prereq`. */
  async drive(stem: string, word: LeafWord, prereq?: string): Promise<void> {
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
 */
const AURORA_ZOO: readonly {
  word: StatusWord;
  phase: string;
  task?: { title: string; leaf: LeafWord };
}[] = [
  {
    phase: 'Onboarding Flow',
    task: { leaf: 'in_progress', title: 'Wire up the welcome carousel' },
    word: 'in_progress',
  },
  {
    phase: 'Push Notifications',
    task: { leaf: 'under_review', title: 'Silent push delivery receipts' },
    word: 'under_review',
  },
  {
    phase: 'Offline Mode',
    task: { leaf: 'ready', title: 'Cache the home feed locally' },
    word: 'ready',
  },
  {
    phase: 'Deep Linking',
    task: { leaf: 'awaiting', title: 'Route universal links to screens' },
    word: 'awaiting',
  },
  {
    phase: 'Payments',
    task: { leaf: 'blocked', title: 'Integrate App Store receipts' },
    word: 'blocked',
  },
  {
    phase: 'Home Widgets',
    task: { leaf: 'parked', title: 'Home-screen glance widget' },
    word: 'parked',
  },
  { phase: 'Authentication', task: { leaf: 'done', title: 'Biometric unlock' }, word: 'done' },
  {
    phase: 'Legacy Bridge',
    task: { leaf: 'abandoned', title: 'Port the old settings sheet' },
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

  // The status zoo: one phase per rollup word, each with its lone leaf.
  let inProgressLeaf: string | undefined;
  let awaitingLeaf: string | undefined;
  let carousel: string | undefined;
  let receipts: string | undefined;
  for (const row of AURORA_ZOO) {
    const phase = await board.phase(core, { title: row.phase });
    if (row.task === undefined) {
      continue; // `new` — a deliberately empty container
    }
    const task = await board.task(phase, { title: row.task.title });
    if (row.task.leaf === 'awaiting') {
      awaitingLeaf = task; // wired after the loop, once its prerequisite exists
    } else {
      await board.drive(task, row.task.leaf);
    }
    if (row.task.leaf === 'in_progress') {
      inProgressLeaf = task;
      carousel = task;
    }
    if (row.task.leaf === 'blocked') {
      receipts = task;
    }
  }

  // Dependency chain: the deep-linking task awaits the in-progress carousel task,
  // which becomes a blocking prerequisite (it now has an unsettled dependent).
  if (awaitingLeaf !== undefined && inProgressLeaf !== undefined) {
    await board.drive(awaitingLeaf, 'awaiting', inProgressLeaf);
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
  await board.drive(await board.task(bugBash, { title: 'Fix crash on cold start' }), 'in_progress');

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

/** Guard the target: regenerate a throwaway fixture vault (empty, absent, or a
 * marked mimir vault), but refuse a non-empty directory that is NOT a vault. */
function prepareTarget(target: string): void {
  if (existsSync(target)) {
    const entries = readdirSync(target).filter((e) => !IGNORABLE.has(e));
    const isVault = existsSync(join(target, MARKER_FILE));
    if (entries.length > 0 && !isVault) {
      throw new Error(
        `${target} is not empty and is not a mimir fixture vault — refusing to overwrite it. ` +
          'Point the generator at an empty path or an existing fixture vault.',
      );
    }
    rmSync(target, { force: true, recursive: true });
  }
}

/**
 * Generate the fixture vault at `target` (created fresh; an existing fixture
 * vault or empty dir is regenerated). Returns a coverage summary read back
 * through the derivation surface. Exported so the integration test drives the
 * same entry point the CLI does.
 */
export async function generateFixtureVault(target: string): Promise<FixtureSummary> {
  const absTarget = isAbsolute(target) ? target : resolve(target);
  prepareTarget(absTarget);
  mkdirSync(absTarget, { recursive: true });
  await converge(absTarget, { allowCreate: true, exec: bunExec });

  const client = new NornClient({ vaultPath: absTarget });
  try {
    const store = createNornWriteStore(client, absTarget);

    // Epoch 1: the going-cold cohort, under a frozen past clock.
    setSystemTime(new Date(Date.now() - COLD_EPOCH_DAYS * 24 * 60 * 60 * 1000));
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
  console.log('\nsmoke it:');
  console.log(`  MIMIR_STORE_BACKEND=norn MIMIR_VAULT=${summary.vaultPath} \\`);
  console.log('    bun run packages/bin/src/main.ts serve');
  return 0;
}

// Run only as a script, never on import (the integration test imports the fn).
if (import.meta.main) {
  process.exitCode = await main();
}
