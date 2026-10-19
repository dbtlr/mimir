/**
 * A small board both CLIs read in the parity cases: two projects, a hierarchy,
 * tasks in every common state, an artifact, and a seed. Test-only.
 */
import { LocalEngine } from '@mimir/core';
import type { Store } from '@mimir/core';
import { createTestStore } from '@mimir/core/testing';

import { createApp } from '../app';

export type ParityBoard = {
  store: Store;
  engine: LocalEngine;
  /** A new Loom CLI over the board, its clone bound to `bound` and its failures reading `argv` as the run's words, when given. */
  app: (bound?: string, argv?: readonly string[]) => ReturnType<typeof createApp>;
  close: () => Promise<void>;
};

/** A git clone stub whose config binds it to `bound`, or leaves it unbound. */
export function boundClone(bound: string | undefined) {
  return {
    originUrl: () => Promise.resolve(undefined),
    readConfig: () => Promise.resolve(bound),
    writeConfig: () => Promise.resolve(false),
  };
}

export async function parityBoard(): Promise<ParityBoard> {
  const { close, store } = await createTestStore();
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
  await engine.start({ id: ship.id });
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
  return {
    app: (bound, argv) =>
      createApp({
        git: boundClone(bound),
        store: () => Promise.resolve(store),
        ...(argv === undefined ? {} : { argv: () => argv }),
      }),
    close,
    engine,
    store,
  };
}
