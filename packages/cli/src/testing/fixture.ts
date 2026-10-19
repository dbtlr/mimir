/**
 * A small board both CLIs read in the parity cases: two projects, a hierarchy,
 * tasks in every common state, an artifact, and a seed. Test-only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Defaults } from '@mimir/bin/src/cli/run';
import { LocalEngine, openSqlite } from '@mimir/core';
import type { DoctorBackend, DoctorFinding, GitPort, Store } from '@mimir/core';
import { createTestStore } from '@mimir/core/testing';

import { createApp } from '../app';
import type { MachineSource } from '../app';

export type ParityBoard = {
  store: Store;
  engine: LocalEngine;
  /**
   * A new Loom CLI over the board, its clone bound to `bound` and reporting `origin`, and its
   * failures reading `argv` as the run's words, when given.
   */
  app: (bound?: string, argv?: readonly string[], origin?: string) => ReturnType<typeof createApp>;
  /** The old CLI's machine-local defaults over the same board, for `runOld`. */
  oldDefaults: (bound?: string, origin?: string) => Defaults;
  /** Findings a doctor case adds to the real, clean diagnosis; clear them after the case. */
  findings: DoctorFinding[];
  /** The text `store import -` reads from standard input. */
  stdin: { text: string };
  /** A scratch directory both CLIs may write files into. */
  dir: string;
  close: () => Promise<void>;
};

/** The pinned `exported_at`, so two exports of one board are equal. */
const EXPORTED_AT = '2026-01-01T00:00:00.000Z';

/** A clone that remembers what is written to its git config, bound to `bound` at the start. */
export function writableClone(bound: string | undefined, origin?: string): GitPort {
  let config = bound;
  return {
    originUrl: () => Promise.resolve(origin),
    readConfig: () => Promise.resolve(config),
    writeConfig: (_key, value) => {
      config = value;
      return Promise.resolve(true);
    },
  };
}

/** The store with its `export` pinned to one instant. */
function pinnedExport(store: Store): Store {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'export') {
        return async () => ({ ...(await target.export()), exported_at: EXPORTED_AT });
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A git clone stub whose config binds it to `bound`, or leaves it unbound. */
export function boundClone(bound: string | undefined) {
  return {
    originUrl: () => Promise.resolve(undefined),
    readConfig: () => Promise.resolve(bound),
    writeConfig: () => Promise.resolve(false),
  };
}

/** Edges a case may replace: the global config and the Postgres connection. */
export type BoardEdges = Partial<Pick<MachineSource, 'openPostgres' | 'readConfig'>>;

export async function parityBoard(replaced: BoardEdges = {}): Promise<ParityBoard> {
  const { close, doctor: real, store: unpinned } = await createTestStore();
  // The board is healthy; a doctor case adds findings the real checks cannot produce here.
  const findings: DoctorFinding[] = [];
  const doctor: DoctorBackend = {
    ...real,
    diagnose: async (scope) => {
      const diagnosis = await real.diagnose(scope);
      return { ...diagnosis, findings: [...diagnosis.findings, ...findings] };
    },
  };
  const store = pinnedExport(unpinned);
  const engine = new LocalEngine(store);
  await engine.create({
    description: 'The work-state store.',
    key: 'MMR',
    name: 'mimir',
    remote: 'git@github.com:dbtlr/mimir.git',
    type: 'project',
  });
  await engine.create({ key: 'XX', name: 'other', type: 'project' });
  const initiative = await engine.create({ parent: 'MMR', title: 'Platform', type: 'initiative' });
  const phase = await engine.create({
    parent: initiative.id,
    target: '2026-11',
    title: 'Skeleton',
    type: 'phase',
  });
  const store1 = await engine.create({
    description: 'Open the store once.\n\nKeep it open.',
    groomed: true,
    parent: phase.id,
    priority: 'p1',
    size: 'small',
    summary: 'one store per run',
    title: 'Wire the store',
    type: 'task',
  });
  const views = await engine.create({ parent: phase.id, title: 'Render views', type: 'task' });
  const ship = await engine.create({
    parent: phase.id,
    priority: 'p0',
    title: 'Ship it',
    type: 'task',
  });
  const blocked = await engine.create({ parent: phase.id, title: 'Wait on review', type: 'task' });
  const finished = await engine.create({ parent: phase.id, title: 'Spike', type: 'task' });
  await engine.create({ parent: phase.id, priority: 'p2', title: 'Tidy docs', type: 'task' });
  await engine.annotate({ content: 'First pass.\nSecond line.', id: store1.id });
  await engine.annotate({ content: 'Settled; one; store.', id: store1.id });
  await engine.tag({ ids: [store1.id, views.id], tags: ['alpha'] });
  await engine.depend({ id: views.id, on: [store1.id] });
  await engine.start({
    harness: 'codex',
    id: ship.id,
    session: 'main-session',
    workerHarness: 'claude',
    workerSession: 'task-worker-session',
  });
  await engine.block({ id: blocked.id, reason: 'needs a reviewer' });
  await engine.start({ id: finished.id });
  await engine.done({ id: finished.id });
  await engine.attach({
    content: '# Notes\n\nThe body.',
    links: [store1.id],
    project: 'MMR',
    summary: 'design notes',
    tags: ['design'],
    title: 'Store notes',
  });
  await engine.seedCreate({
    description: 'Ask the other board for a hook.',
    kind: 'feature',
    project: 'MMR',
    requester: 'XX',
    title: 'A hook',
  });
  const other = await engine.create({ parent: 'XX', title: 'Elsewhere', type: 'initiative' });
  const otherPhase = await engine.create({ parent: other.id, title: 'Far', type: 'phase' });
  await engine.create({ parent: otherPhase.id, title: 'Not ours', type: 'task' });
  const dir = mkdtempSync(join(tmpdir(), 'mimir-parity-'));
  const stdin = { text: '' };
  const edges = {
    cwd: dir,
    openPostgres: () => {
      throw new Error('the fixture is sqlite');
    },
    openSqlite: () => openSqlite(':memory:'),
    readConfig: () => ({ store: {} }),
    readStdin: () => Promise.resolve(stdin.text),
    ...replaced,
  };
  const machine: MachineSource = {
    ...edges,
    doctor: () => Promise.resolve(doctor),
  };
  return {
    app: (bound, argv, origin) =>
      createApp({
        git: writableClone(bound, origin),
        machine,
        store: () => Promise.resolve(store),
        ...(argv === undefined ? {} : { argv: () => argv }),
      }),
    close: () => {
      rmSync(dir, { force: true, recursive: true });
      return close();
    },
    dir,
    engine,
    findings,
    oldDefaults: (bound, origin) => ({
      cwd: dir,
      doctor,
      git: writableClone(bound, origin),
      store: edges,
    }),
    stdin,
    store,
  };
}
