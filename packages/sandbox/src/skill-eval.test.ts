import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summarize } from './skill-eval';
import type { RunResult } from './skill-eval';
import { agentPath } from './skill-eval-sandbox';
import { asksToConfirmKey, isWrite, SCENARIOS, UNIVERSAL_CHECKS } from './skill-eval-scenarios';
import type { Evidence } from './skill-eval-scenarios';
import { mimirCalls } from './skill-eval-transcript';

test('the agent PATH leads with the sandbox and drops every directory holding another mimir', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-eval-path-'));
  try {
    const live = join(root, 'live');
    const tools = join(root, 'tools');
    mkdirSync(live);
    mkdirSync(tools);
    writeFileSync(join(live, 'mimir'), '');
    chmodSync(join(live, 'mimir'), 0o755);
    expect(agentPath('/eval/bin', `${live}:${tools}:/eval/bin`)).toBe(`/eval/bin:${tools}`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('reads and triage leave the board unwritten; mutations and scratch edits write it', () => {
  const calls = mimirCalls([
    'mimir overview',
    'mimir triage',
    'mimir scratch get abc',
    'mimir scratch checkpoint abc "x" --expected-updated-at t',
    'mimir start QEV-2',
  ]);
  expect(calls.map(isWrite)).toEqual([false, false, false, true, true]);
});

const scenarioNamed = (name: string) => {
  const found = SCENARIOS.find((s) => s.name === name);
  if (found === undefined) {
    throw new Error(`no scenario ${name}`);
  }
  return found;
};

function evidenceWithHistory(work: string, startedAt: string): Evidence {
  const view = {
    description: null,
    history: [{ at: startedAt, from: 'todo', kind: 'lifecycle', reason: null, to: 'in_progress' }],
    hold: 'none',
    id: 'QEV-2',
    lifecycle: 'done',
    title: 'Fix the greeting typo',
    upstream: null,
  };
  return {
    calls: [],
    ids: { task: 'QEV-2' },
    mimir: () => Promise.resolve(JSON.stringify(view)),
    transcript: { commands: [], finalText: '', skills: [] },
    work,
  };
}

test('start-done grades start-before-edit from the store and the file, not the transcript', async () => {
  const work = mkdtempSync(join(tmpdir(), 'skill-eval-work-'));
  try {
    writeFileSync(join(work, 'greet.js'), "export const greeting = 'Hello, world';\n");
    const editedAt = new Date('2026-10-01T12:00:00Z');
    utimesSync(join(work, 'greet.js'), editedAt, editedAt);
    const check = scenarioNamed('start-done').checks.find(
      (c) => c.name === 'starts before editing',
    );
    expect(await check?.test(evidenceWithHistory(work, '2026-10-01T11:59:00Z'))).toBe(true);
    expect(await check?.test(evidenceWithHistory(work, '2026-10-01T12:01:00Z'))).toBe(false);
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
});

test('scenario names are unique and every scenario carries checks', () => {
  const names = SCENARIOS.map((s) => s.name);
  expect(new Set(names).size).toBe(names.length);
  for (const s of SCENARIOS) {
    expect(s.checks.length).toBeGreaterThan(0);
  }
});

const runResult = (scenario: string, harness: 'claude' | 'codex', passed: boolean): RunResult => ({
  attempt: 1,
  checks: [],
  durationMs: 1,
  exit: 0,
  finalText: '',
  harness,
  mimirCalls: [],
  model: 'default',
  passed,
  root: '/x',
  scenario,
});

test('the summary counts passes per scenario and harness', () => {
  const table = summarize([
    runResult('orient', 'claude', true),
    runResult('orient', 'claude', false),
    runResult('orient', 'codex', true),
  ]);
  expect(table.split('\n').map((line) => line.split(/\s+/))).toEqual([
    ['scenario', 'claude:default', 'codex:default'],
    ['orient', '1/2', '1/1'],
    ['total', '1/2', '1/1'],
  ]);
});

const commandEvidence = (commands: string[]): Evidence => ({
  calls: mimirCalls(commands),
  ids: {},
  mimir: () => Promise.resolve(''),
  transcript: { commands, finalText: '', skills: [] },
  work: '/',
});

test('a guessed verb fails the universal check; real verbs pass it', () => {
  const [guessed] = UNIVERSAL_CHECKS;
  expect(guessed?.test(commandEvidence(['mimir overview', 'mimir get QEV-2']))).toBe(true);
  expect(guessed?.test(commandEvidence(['mimir show QEV-2']))).toBe(false);
});

test('a key proposal counts as asking whether it ends in a question or requests confirmation', () => {
  expect(asksToConfirmKey('Should I use WGT as the key?')).toBe(true);
  expect(asksToConfirmKey('Please confirm its permanent project key: **WGT**.')).toBe(true);
  expect(asksToConfirmKey('Created project WGT and bound the repo.')).toBe(false);
});
