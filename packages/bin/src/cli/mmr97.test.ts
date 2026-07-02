/**
 * MMR-97 — CLI language pass: the per-verb what-happened signpost (styled
 * formats only), the onward empty-set lines, and the noun-policy error voice
 * (no "node" leaks; the id leads).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  createInitiative,
  createPhase,
  createProject,
  createSqliteStore,
  createTask,
} from '../core';
import type { Db, Store } from '../core';
import { createTestDb } from '../db/testing';
import { runCli } from './run';
import { fakeIo } from './testing';

let db: Db;
let store: Store;
let taskRef: string;
let task2Ref: string;
let phaseRef: string;

beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(store, { projectId: p.id, title: 'Init' });
  const phase = await createPhase(store, { parentId: init.id, title: 'Phase' });
  phaseRef = `MMR-${String(phase.seq)}`;
  const t1 = await createTask(store, { parentId: phase.id, title: 'One' });
  const t2 = await createTask(store, { parentId: phase.id, title: 'Two' });
  taskRef = `MMR-${String(t1.seq)}`;
  task2Ref = `MMR-${String(t2.seq)}`;
});
afterEach(async () => {
  await db.destroy();
});

describe('mutation signpost — styled formats only', () => {
  test('start emits the transition signpost above the record (records format)', async () => {
    const io = fakeIo(false);
    await runCli(['start', taskRef, '-f', 'records'], () => store, io);
    expect(io.out.join('\n')).toContain(`[ok] started ${taskRef} · todo → in_progress`);
  });

  test('json carries only the record — no signpost prose', async () => {
    const io = fakeIo(false);
    await runCli(['start', taskRef, '-f', 'json'], () => store, io);
    const text = io.out.join('');
    expect(text).not.toContain('started');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  test('ids carries only the id — no signpost prose', async () => {
    const io = fakeIo(false);
    await runCli(['start', taskRef, '-f', 'ids'], () => store, io);
    expect(io.out.join('')).toBe(taskRef);
  });

  test("reorder names the effect the record can't show (rank is never a field)", async () => {
    const io = fakeIo(false);
    await runCli(['reorder', task2Ref, '--top', '-f', 'records'], () => store, io);
    expect(io.out.join('\n')).toContain(`[ok] reordered ${task2Ref} → top`);
  });

  test('move names the new parent', async () => {
    const io = fakeIo(false);
    await runCli(['move', taskRef, '--to', phaseRef, '-f', 'records'], () => store, io);
    expect(io.out.join('\n')).toContain(`[ok] moved ${taskRef} → ${phaseRef}`);
  });

  test('depend names the edge', async () => {
    const io = fakeIo(false);
    await runCli(['depend', task2Ref, '--on', taskRef, '-f', 'records'], () => store, io);
    expect(io.out.join('\n')).toContain(`[ok] ${task2Ref} now depends on ${taskRef}`);
  });
});

describe('empty-set lines point onward (TTY)', () => {
  test('list with no matches suggests widening', async () => {
    const io = fakeIo(true);
    await runCli(['list', '--status', 'done'], () => store, io);
    expect(io.out.join('\n')).toContain('No tasks match — try --status all, or drop a filter');
  });

  test('next with nothing ready points at the queue', async () => {
    const io = fakeIo(true);
    // park both tasks so nothing is ready
    await runCli(['park', taskRef], () => store, fakeIo(false));
    await runCli(['park', task2Ref], () => store, fakeIo(false));
    await runCli(['next', '-s', 'MMR'], () => store, io);
    expect(io.out.join('\n')).toContain("mimir list --status awaiting -s MMR shows what's queued");
  });
});

describe("noun-policy error voice — no 'node', id leads", () => {
  test("a missing id reads as '<id> doesn't exist'", async () => {
    const io = fakeIo(false);
    await runCli(['get', 'MMR-9999'], () => store, io);
    const err = io.err.join(' ');
    expect(err).toContain("MMR-9999 doesn't exist");
    expect(err).not.toContain('node');
  });

  test("a task-only verb names the precise type (start → 'not a task')", async () => {
    const io = fakeIo(false);
    await runCli(['start', 'MMR'], () => store, io);
    const err = io.err.join(' ');
    expect(err).toContain('MMR is a project, not a task');
    expect(err).not.toContain('node');
  });

  test('a generic verb enumerates the work types (annotate default)', async () => {
    const io = fakeIo(false);
    await runCli(['annotate', 'MMR', 'hi'], () => store, io);
    const err = io.err.join(' ');
    expect(err).toContain('MMR is a project, not a task, phase, or initiative');
    expect(err).not.toContain('node');
  });

  test("the parent rule reads identically and names the wrong type, not 'node'", async () => {
    const io = fakeIo(false);
    await runCli(['create', 'phase', 'X', '--parent', taskRef], () => store, io);
    const err = io.err.join(' ');
    expect(err).toContain("a phase's parent must be an initiative, not a task");
    expect(err).not.toContain('node');
  });
});
