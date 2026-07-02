/**
 * MMR-90 — Self-orienting entity responses: child titles, rollup signpost,
 * onward TTY hint, and `mimir tree <id>`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

import {
  createInitiative,
  createPhase,
  createProject,
  createSqliteStore,
  createTask,
  nodeTree,
} from '../core';
import type { Db, Store } from '../core';
import { createTestDb } from '../db/testing';
import { runCli } from './run';
import { fakeIo } from './testing';

let db: Db;
let store: Store;
let phaseId: number;
let phaseSeq: number;
let initSeq: number;

beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(db, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(db, { projectId: p.id, title: 'The Initiative' });
  initSeq = init.seq;
  const phase = await createPhase(db, { parentId: init.id, title: 'Phase One' });
  phaseId = phase.id;
  phaseSeq = phase.seq;
});
afterEach(async () => {
  await db.destroy();
});

// ─── Deliverable 1: Child titles ───────────────────────────────────────────

describe('NodeRef titles (deliverable 1)', () => {
  test('children refs carry the title alongside id+status', async () => {
    await createTask(db, { parentId: phaseId, title: 'First task' });
    const io = fakeIo(false);
    await runCli(['get', `MMR-${String(phaseSeq)}`, '-f', 'json'], () => store, io);
    const view = parseJson<{
      children: { id: string; status: string; title: string }[];
    }>(io.out.join(''));
    expect(view.children).toHaveLength(1);
    expect(view.children[0]?.title).toBe('First task');
  });

  test('dependsOn/blocking refs carry the title', async () => {
    const a = await createTask(db, { parentId: phaseId, title: 'Alpha' });
    const b = await createTask(db, { parentId: phaseId, title: 'Beta' });
    const aRef = `MMR-${String(a.seq)}`;
    const bRef = `MMR-${String(b.seq)}`;
    await runCli(['depend', bRef, '--on', aRef], () => store, fakeIo(false));

    const ioA = fakeIo(false);
    await runCli(['get', aRef, '-f', 'json'], () => store, ioA);
    const viewA = parseJson<{
      deps: { blocking: { id: string; title: string }[] };
    }>(ioA.out.join(''));
    expect(viewA.deps.blocking[0]?.title).toBe('Beta');

    const ioB = fakeIo(false);
    await runCli(['get', bRef, '-f', 'json'], () => store, ioB);
    const viewB = parseJson<{
      deps: { depends_on: { id: string; title: string }[] };
    }>(ioB.out.join(''));
    expect(viewB.deps.depends_on[0]?.title).toBe('Alpha');
  });

  test('renderRecords shows title in children line', async () => {
    await createTask(db, { parentId: phaseId, title: 'My Task' });
    const io = fakeIo(false);
    await runCli(['get', `MMR-${String(phaseSeq)}`, '-f', 'records'], () => store, io);
    const text = io.out.join('');
    expect(text).toContain('My Task');
  });
});

// ─── Deliverable 2: Rollup signpost + TTY onward hint ───────────────────────

describe('Rollup signpost and TTY hint (deliverable 2)', () => {
  test('records for a container shows rollup signpost on TTY', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    await createTask(db, { parentId: phaseId, title: 't2' });
    const tty = fakeIo(true); // TTY
    await runCli(['get', `MMR-${String(phaseSeq)}`], () => store, tty);
    const text = tty.out.join('');
    expect(text).toMatch(/rollup/);
    expect(text).toMatch(/\d+ direct child/);
  });

  test('TTY records for a container includes onward hint pointing to mimir tree', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    const tty = fakeIo(true);
    await runCli(['get', `MMR-${String(phaseSeq)}`], () => store, tty);
    const text = tty.out.join('');
    expect(text).toContain('mimir tree');
  });

  test('structured json format has NO prose hint (machine contract)', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    const io = fakeIo(false);
    await runCli(['get', `MMR-${String(phaseSeq)}`, '-f', 'json'], () => store, io);
    const text = io.out.join('');
    // Must not contain prose hint in JSON
    expect(text).not.toContain('mimir tree');
    // But must still contain the distribution data
    const view = parseJson<{ distribution: Record<string, number> }>(text);
    expect(view.distribution).toBeDefined();
  });

  test('jsonl format has NO prose hint (machine contract)', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    const io = fakeIo(false);
    await runCli(['get', `MMR-${String(phaseSeq)}`, '-f', 'jsonl'], () => store, io);
    const text = io.out.join('');
    expect(text).not.toContain('mimir tree');
  });

  test('ids format has NO prose hint (machine contract)', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    const io = fakeIo(false);
    await runCli(['get', `MMR-${String(phaseSeq)}`, '-f', 'ids'], () => store, io);
    const text = io.out.join('');
    expect(text).not.toContain('mimir tree');
    // ids format: just the id
    expect(text.trim()).toBe(`MMR-${String(phaseSeq)}`);
  });

  test('non-TTY records format has NO onward hint', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    const piped = fakeIo(false); // non-TTY
    await runCli(['get', `MMR-${String(phaseSeq)}`], () => store, piped);
    const text = piped.out.join('');
    // The records show data, but no hint prose
    expect(text).not.toContain('mimir tree');
  });

  test('leaf task records shows no rollup signpost', async () => {
    const t = await createTask(db, { parentId: phaseId, title: 'leaf' });
    const tty = fakeIo(true);
    await runCli(['get', `MMR-${String(t.seq)}`], () => store, tty);
    const text = tty.out.join('');
    expect(text).not.toMatch(/rollup/);
    expect(text).not.toContain('mimir tree');
  });
});

// ─── Fix 1: status -f records signpost (MMR-90 review) ──────────────────────

describe('status -f records signpost (MMR-90 review fix 1)', () => {
  test('status <container> -f records on TTY shows rollup signpost', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    await createTask(db, { parentId: phaseId, title: 't2' });
    const tty = fakeIo(true);
    await runCli(['status', `MMR-${String(phaseSeq)}`, '-f', 'records'], () => store, tty);
    const text = tty.out.join('');
    expect(text).toMatch(/rollup/);
    expect(text).toMatch(/\d+ direct child/);
    expect(text).toContain('mimir tree');
  });

  test('status <container> default (json) has NO prose hint and is structurally unchanged', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    const io = fakeIo(true); // even TTY: json path must stay clean
    await runCli(['status', `MMR-${String(phaseSeq)}`], () => store, io);
    const text = io.out.join('');
    expect(text).not.toContain('mimir tree');
    expect(text).not.toContain('hint');
    const parsed = parseJson<{
      id: string;
      status: string;
      distribution: Record<string, number>;
    }>(text);
    expect(parsed.id).toBeDefined();
    expect(parsed.status).toBeDefined();
    expect(parsed.distribution).toBeDefined();
  });

  test('status <EMPTY container> -f records on TTY shows signpost and onward hint', async () => {
    // Phase with no tasks — empty container, distribution is {}
    const tty = fakeIo(true);
    await runCli(['status', `MMR-${String(phaseSeq)}`, '-f', 'records'], () => store, tty);
    const text = tty.out.join('');
    expect(text).toMatch(/rollup/);
    expect(text).toMatch(/direct child/);
    expect(text).toContain('mimir tree');
  });

  test("status with exactly 1 child reads '1 direct child' (singular)", async () => {
    await createTask(db, { parentId: phaseId, title: 'solo' });
    const tty = fakeIo(true);
    await runCli(['status', `MMR-${String(phaseSeq)}`, '-f', 'records'], () => store, tty);
    const text = tty.out.join('');
    expect(text).toContain('1 direct child');
    // Must NOT use "children" (plural) when n=1
    expect(text).not.toMatch(/1 direct children/);
  });

  test("status default json output does not include 'type' field (machine contract unchanged)", async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    const io = fakeIo(false);
    await runCli(['status', `MMR-${String(phaseSeq)}`], () => store, io);
    const parsed = parseJson<Record<string, unknown>>(io.out.join(''));
    // The json wire format must stay prose-free and must NOT expose the internal type field
    expect(parsed.type).toBeUndefined();
    expect(parsed.id).toBeDefined();
    expect(parsed.status).toBeDefined();
    expect(parsed.distribution).toBeDefined();
  });
});

// ─── Deliverable 3: mimir tree <id> ─────────────────────────────────────────

describe('mimir tree (deliverable 3)', () => {
  test('nodeTree can root at a project key', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    const tree = await nodeTree(db, 'MMR');
    expect(tree.id).toBe('MMR');
    expect(tree.type).toBe('project');
    expect(tree.children.length).toBeGreaterThan(0);
  });

  test('nodeTree can root at any node id (mid-tree)', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    const tree = await nodeTree(db, `MMR-${String(initSeq)}`);
    expect(tree.id).toBe(`MMR-${String(initSeq)}`);
    expect(tree.children.length).toBeGreaterThan(0);
    // Should have phase as child, which has tasks under it
    const phase = tree.children.find((c) => c.id === `MMR-${String(phaseSeq)}`);
    expect(phase).toBeDefined();
    expect(phase?.children.length).toBe(1);
  });

  test('mimir tree CLI verb renders an indented hierarchy', async () => {
    await createTask(db, { parentId: phaseId, title: 'leaf task' });
    const io = fakeIo(true);
    const code = await runCli(['tree', 'MMR'], () => store, io);
    expect(code).toBe(0);
    const text = io.out.join('');
    expect(text).toContain('MMR');
    expect(text).toContain('Phase One');
    expect(text).toContain('leaf task');
    // Check indentation: children should be indented
    const lines = text.split('\n').filter((l) => l.length > 0);
    // The phase line should be indented (has leading spaces)
    const phaseLine = lines.find((l) => l.includes('Phase One'));
    expect(phaseLine).toBeDefined();
    expect(phaseLine).toMatch(/^\s+/);
  });

  test('mimir tree CLI verb with a mid-tree node id', async () => {
    await createTask(db, { parentId: phaseId, title: 'leaf task' });
    const io = fakeIo(true);
    const code = await runCli(['tree', `MMR-${String(initSeq)}`], () => store, io);
    expect(code).toBe(0);
    const text = io.out.join('');
    expect(text).toContain('The Initiative');
    expect(text).toContain('Phase One');
    expect(text).toContain('leaf task');
  });

  test('mimir tree -f json emits a tree object', async () => {
    await createTask(db, { parentId: phaseId, title: 't1' });
    const io = fakeIo(false);
    const code = await runCli(['tree', 'MMR', '-f', 'json'], () => store, io);
    expect(code).toBe(0);
    const parsed = parseJson<{
      id: string;
      children: { id: string; children: unknown[] }[];
    }>(io.out.join(''));
    expect(parsed.id).toBe('MMR');
    expect(Array.isArray(parsed.children)).toBe(true);
  });

  test('mimir tree missing id exits non-zero', async () => {
    const io = fakeIo(false);
    const code = await runCli(['tree', 'MMR-999'], () => store, io);
    expect(code).toBe(1);
  });

  test('mimir tree without an id is a usage error', async () => {
    const io = fakeIo(false);
    const code = await runCli(['tree'], () => store, io);
    expect(code).toBe(2);
  });

  test('mimir tree --help shows usage text for tree verb', async () => {
    const io = fakeIo(true);
    // The global --help includes tree
    const code = await runCli(['--help'], () => store, io);
    expect(code).toBe(0);
    const text = io.out.join('');
    expect(text).toContain('tree');
  });
});
