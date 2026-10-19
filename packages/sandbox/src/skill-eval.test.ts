import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { escapes, summarize } from './skill-eval';
import type { RunResult } from './skill-eval';
import { agentPath } from './skill-eval-sandbox';
import { asksToConfirmKey, SCENARIOS, UNIVERSAL_CHECKS } from './skill-eval-scenarios';
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

test('a named mimir executable other than the sandbox binary is an escape; directories are not', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-eval-escape-'));
  try {
    const sandboxBin = join(root, 'bin', 'mimir');
    const live = join(root, 'live', 'mimir');
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'live'));
    mkdirSync(join(root, 'skills', 'mimir'), { recursive: true });
    writeFileSync(sandboxBin, '');
    writeFileSync(live, '');
    expect(
      escapes(
        [`${sandboxBin} next`, `${live} list`, `ls ${join(root, 'skills', 'mimir')}`],
        sandboxBin,
      ),
    ).toEqual([live]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
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
    storeAfter: {},
    storeChanged: true,
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
  skills: [],
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
  storeAfter: {},
  storeChanged: false,
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
  expect(asksToConfirmKey('OK, what should the API do?')).toBe(false);
  expect(asksToConfirmKey('Created project WGT and bound the repo.')).toBe(false);
});

const queueRunEvidence = (
  commands: string[],
  overrides: Record<string, unknown> = {},
): Evidence => {
  const queued = {
    at: '2026-10-19T12:00:00Z',
    from: 'todo',
    handles: { harness: 'codex', session: 'eval-run-session' },
    kind: 'lifecycle',
    reason: null,
    to: 'queued',
  };
  const views: Record<string, unknown> = {
    'QEV-2': {
      harness: 'claude',
      history: [
        queued,
        {
          ...queued,
          from: 'queued',
          handles: { harness: 'claude', session: 'eval-worker-session' },
          to: 'in_progress',
        },
      ],
      hold: 'none',
      id: 'QEV-2',
      lifecycle: 'in_progress',
      session: 'eval-worker-session',
      title: 'Worker task',
      upstream: null,
    },
    'QEV-3': {
      harness: null,
      history: [queued, { ...queued, from: 'queued', reason: 'Run cancelled', to: 'todo' }],
      hold: 'none',
      id: 'QEV-3',
      lifecycle: 'todo',
      session: null,
      title: 'Cancelled task',
      upstream: null,
    },
    ...overrides,
  };
  return {
    ...commandEvidence(commands),
    ids: { cancelled: 'QEV-3', started: 'QEV-2' },
    mimir: (args) => Promise.resolve(JSON.stringify(views[args[1] ?? ''])),
    storeChanged: true,
  };
};

const queueRunCommands = [
  'mimir queue QEV-2 --harness codex --session eval-run-session',
  'mimir queue QEV-3 --harness codex --session eval-run-session',
  'mimir start QEV-2 --harness claude --session eval-worker-session',
  'mimir unqueue QEV-3 "Run cancelled"',
];

const queueRunLoopCommands = [
  'for id in QEV-2 QEV-3; do mimir queue "$id" --harness codex --session eval-run-session; done',
  ...queueRunCommands.slice(2),
];

test('queue-run accepts loop task operands and still requires exact stored transitions', async () => {
  const scenario = scenarioNamed('queue-run');
  for (const check of scenario.checks) {
    expect(await check.test(queueRunEvidence(queueRunLoopCommands))).toBe(true);
  }
  const succession = scenario.checks.find(
    (c) => c.name === 'records the run and worker succession',
  );
  expect(
    await succession?.test(
      queueRunEvidence(queueRunLoopCommands, {
        'QEV-2': {
          history: [],
          hold: 'none',
          id: 'QEV-2',
          lifecycle: 'todo',
          title: 'Worker task',
          upstream: null,
        },
      }),
    ),
  ).toBe(false);
  const handles = scenario.checks.find((c) => c.name === 'passes explicit run and worker handles');
  expect(
    await handles?.test(
      queueRunEvidence([
        'for id in QEV-2 QEV-3; do echo mimir queue "$id" --harness codex --session eval-run-session; done',
        ...queueRunCommands.slice(2),
      ]),
    ),
  ).toBe(false);
});

test('queue-run requires actual queue, worker start, and cancellation transitions', async () => {
  const scenario = scenarioNamed('queue-run');
  for (const check of scenario.checks) {
    expect(await check.test(queueRunEvidence(queueRunCommands))).toBe(true);
  }
  const check = scenario.checks.find((c) => c.name === 'records the run and worker succession');
  expect(
    await check?.test(
      queueRunEvidence(queueRunCommands, {
        'QEV-2': {
          history: [],
          hold: 'none',
          id: 'QEV-2',
          lifecycle: 'in_progress',
          title: 'Worker task',
          upstream: null,
        },
      }),
    ),
  ).toBe(false);
});

test('queue-run ignores handles in shell comments and requires both reservations before worker start', async () => {
  const check = scenarioNamed('queue-run').checks.find(
    (c) => c.name === 'passes explicit run and worker handles',
  );
  expect(
    await check?.test(
      queueRunEvidence([
        'mimir queue QEV-2 # --harness codex --session eval-run-session',
        ...queueRunCommands.slice(1),
      ]),
    ),
  ).toBe(false);
  expect(
    await check?.test(
      queueRunEvidence([
        queueRunCommands[0] ?? '',
        queueRunCommands[2] ?? '',
        queueRunCommands[1] ?? '',
        queueRunCommands[3] ?? '',
      ]),
    ),
  ).toBe(false);
});

test('queue-run requires explicit handles on each reservation and worker start, scoped to its call', async () => {
  const check = scenarioNamed('queue-run').checks.find(
    (c) => c.name === 'passes explicit run and worker handles',
  );
  expect(await check?.test(queueRunEvidence(queueRunCommands))).toBe(true);
  expect(
    await check?.test(
      queueRunEvidence([
        'mimir queue QEV-2; mimir queue QEV-3 --harness codex --session eval-run-session',
        ...queueRunCommands.slice(2),
      ]),
    ),
  ).toBe(false);
  expect(
    await check?.test(
      queueRunEvidence([
        ...queueRunCommands.slice(0, 2),
        'mimir start QEV-2',
        'mimir start QEV-2 --help --harness claude --session eval-worker-session',
        queueRunCommands[3] ?? '',
      ]),
    ),
  ).toBe(false);
  expect(
    await check?.test(
      queueRunEvidence([
        ...queueRunCommands.slice(0, 2),
        'mimir start QEV-2 --harness claude --session ""',
        queueRunCommands[3] ?? '',
      ]),
    ),
  ).toBe(false);
  expect(
    await check?.test(
      queueRunEvidence([
        ...queueRunCommands.slice(0, 2),
        'mimir start QEV-2 --harness claude --session eval-worker-session --session ""',
        queueRunCommands[3] ?? '',
      ]),
    ),
  ).toBe(false);
});
