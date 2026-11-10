import type { Grooming } from '@mimir/contract';
import { describe, expect, it } from 'vitest';

import type { GroomCancelResult, GroomRefusal } from '../api/fns/agent';
import {
  cancelAnswerText,
  deriveAgentCard,
  formatTokens,
  refusalText,
  resetText,
  runInScope,
  scopedRun,
  sharePercent,
} from '../lib/agent-card';
import { clockTime } from '../lib/time';
import { agentBudget, agentRun, endedRun, readyCard, runningActivity } from './agent-fixtures';
import { engineTree } from './engine-fixtures';

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [12_400, '12k'],
    [360_000, '0.36M'],
    [2_400_000, '2.4M'],
    [4_000_000, '4M'],
    [10_000_000, '10M'],
    [10_050_000, '10.05M'],
  ])('%i reads %s', (tokens, text) => {
    expect(formatTokens(tokens)).toBe(text);
  });
});

describe('clockTime', () => {
  it('reads a local time of day in the reader’s zone with a plain space', () => {
    expect(clockTime(new Date('2026-06-02T00:00:00.000Z'))).toBe('8:00 PM');
  });
});

const derive = (card: Parameters<typeof deriveAgentCard>[0], grooming: Grooming = 'not_groomed') =>
  deriveAgentCard(card, 'MMR-640', grooming).kind;

describe('deriveAgentCard', () => {
  it('puts a misconfigured runtime first, with the setting and problem', () => {
    expect(
      deriveAgentCard(
        { problem: 'unset', setting: 'MIMIR_HOSTS', state: 'misconfigured' },
        'MMR-640',
        'groomed',
      ),
    ).toEqual({ kind: 'misconfigured', problem: 'unset', setting: 'MIMIR_HOSTS' });
  });

  it('puts a refused token next, with the token file’s age', () => {
    const tokenModifiedAt = new Date('2025-11-01T00:00:00.000Z');
    expect(
      deriveAgentCard(
        { reason: 'rejected', state: 'disconnected', tokenModifiedAt },
        'MMR-640',
        'not_groomed',
      ),
    ).toEqual({ kind: 'disconnected', tokenModifiedAt });
  });

  it('reads managed settings on the host as managed policy, naming the paths', () => {
    const paths = ['/etc/claude-code/managed-settings.json'];
    expect(deriveAgentCard({ paths, state: 'managed-policy' }, 'MMR-640', 'groomed')).toEqual({
      kind: 'managed-policy',
      paths,
    });
  });

  it('reads a live run on this task as running', () => {
    const run = agentRun();
    expect(deriveAgentCard(readyCard({ running: run }), 'MMR-640', 'not_groomed')).toEqual({
      kind: 'running',
      run,
    });
  });

  it('reads a stale run on this task as stale, which a start recovers', () => {
    const run = agentRun({ stale: true });
    expect(deriveAgentCard(readyCard({ running: run }), 'MMR-640', 'not_groomed')).toEqual({
      kind: 'stale',
      run,
    });
  });

  it('lets a stale run on another task fall through, since a start recovers it', () => {
    const stale = agentRun({ stale: true, task: 'MMR-612' });
    expect(derive(readyCard({ running: stale }))).toBe('ready');
    expect(derive(readyCard({ hasRemote: false, running: stale }))).toBe('no-remote');
    expect(derive(readyCard({ budget: agentBudget({ remainingTokens: 0 }), running: stale }))).toBe(
      'budget',
    );
    expect(derive(readyCard({ running: stale }), 'groomed')).toBe('groomed');
  });

  it('reads a run on another task as busy, ahead of every later state', () => {
    const card = readyCard({
      budget: agentBudget({ remainingTokens: 0 }),
      hasRemote: false,
      running: agentRun({ task: 'MMR-612' }),
    });
    expect(derive(card)).toBe('busy');
  });

  it('reads a missing remote ahead of the budget and the last run', () => {
    const card = readyCard({
      budget: agentBudget({ remainingTokens: 0 }),
      hasRemote: false,
      lastRun: endedRun('failed', 'x'),
    });
    expect(derive(card)).toBe('no-remote');
  });

  it('reads a budget short of one run as budget, ahead of the last run', () => {
    const card = readyCard({
      budget: agentBudget({ remainingTokens: 3_999_999 }),
      lastRun: endedRun('failed', 'x'),
    });
    expect(derive(card)).toBe('budget');
  });

  it('lets a budget of exactly one run start', () => {
    expect(derive(readyCard({ budget: agentBudget({ remainingTokens: 4_000_000 }) }))).toBe(
      'ready',
    );
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'reads a %s last run as failed',
    (state) => {
      expect(derive(readyCard({ lastRun: endedRun(state, 'x') }), 'groomed')).toBe('failed');
    },
  );

  it('reads a groomed task as groomed, with the succeeded run when there is one', () => {
    const run = endedRun('succeeded', 'Groomed');
    expect(deriveAgentCard(readyCard({ lastRun: run }), 'MMR-640', 'groomed')).toEqual({
      kind: 'groomed',
      run,
    });
    expect(deriveAgentCard(readyCard(), 'MMR-640', 'groomed')).toEqual({
      kind: 'groomed',
      run: null,
    });
  });

  it('reads needs answers after a succeeded run as answers', () => {
    expect(derive(readyCard({ lastRun: endedRun('succeeded', 'Asked') }), 'needs_answers')).toBe(
      'answers',
    );
  });

  it('offers a start when answers are needed but no run asked', () => {
    expect(derive(readyCard(), 'needs_answers')).toBe('ready');
  });

  it('is ready otherwise', () => {
    expect(derive(readyCard({ lastRun: endedRun('succeeded', 'Done') }))).toBe('ready');
  });
});

describe('refusalText', () => {
  const cases: [GroomRefusal, RegExp][] = [
    [{ reason: 'unconfigured' }, /not set up/],
    [{ problem: 'unset', reason: 'misconfigured', setting: 'MIMIR_HOSTS' }, /MIMIR_HOSTS is unset/],
    [{ reason: 'disconnected' }, /MIMIR_AGENT_TOKEN_FILE/],
    [
      { paths: ['/etc/claude-code/managed-settings.json', '/a/b'], reason: 'managed-policy' },
      /\/etc\/claude-code\/managed-settings\.json, \/a\/b/,
    ],
    [{ reason: 'task-not-found' }, /no longer exists/],
    [{ lifecycle: 'in_progress', reason: 'task-not-todo' }, /only a todo task.*in_progress/i],
    [{ reason: 'no-remote' }, /no remote/],
    [
      {
        dailyTokens: 10_000_000,
        reason: 'budget',
        resetsAt: new Date('2026-06-02T00:00:00.000Z'),
        runTokens: 4_000_000,
        timezone: 'UTC',
        usedTokens: 7_100_000,
      },
      /reserves 4M tokens and only 2\.9M are left.*resets at 8:00 PM \(midnight UTC\)/,
    ],
    [
      { reason: 'busy', running: { id: 'r', startedAt: new Date(), task: 'MMR-612' } },
      /one started grooming MMR-612 just now\.$/,
    ],
    [{ reason: 'busy', running: null }, /Try again/],
  ];

  it.each(cases)('words %j', (refusal, pattern) => {
    expect(refusalText(refusal)).toMatch(pattern);
  });
});

describe('cancelAnswerText', () => {
  const cases: [Exclude<GroomCancelResult, { state: 'cancelling' }>, string][] = [
    [{ state: 'ending' }, 'The run is already finishing on its own.'],
    [{ runState: 'succeeded', state: 'ended' }, 'The run already ended (succeeded).'],
    [{ state: 'unknown' }, 'This run no longer exists.'],
    [{ state: 'stale' }, "The run's host stopped reporting. Starting a new run clears it."],
    [
      { state: 'closing' },
      'This host could not close the run. It stops reporting within two minutes, and starting a new run then clears it.',
    ],
    [
      { state: 'another-host' },
      'Another host is running this. Try again shortly, or wait for it to finish.',
    ],
  ];

  it.each(cases)('says what %j meant', (answer, sentence) => {
    expect(cancelAnswerText(answer)).toBe(sentence);
  });
});

describe('work page scope', () => {
  const tree = engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
    engineTree({ id: 'MMR-1', status: 'in_progress', title: 'Init', type: 'initiative' }, [
      engineTree({ id: 'MMR-2', status: 'in_progress', title: 'Phase', type: 'phase' }, [
        engineTree({ id: 'MMR-640', status: 'ready', title: 'Task', type: 'task' }),
      ]),
    ]),
  ]);
  const run = agentRun();

  it('holds a run of the same project on the project page, and no other project’s', () => {
    expect(runInScope(run, 'MMR')).toBe(true);
    expect(runInScope(run, 'OTH')).toBe(false);
  });

  it('holds a run whose task is in the container subtree, at any depth', () => {
    expect(runInScope(run, 'MMR', { id: 'MMR-2', tree })).toBe(true);
    expect(runInScope(run, 'MMR', { id: 'MMR-1', tree })).toBe(true);
  });

  it('leaves out a run outside the subtree or while the tree is unread', () => {
    expect(runInScope(agentRun({ task: 'MMR-9' }), 'MMR', { id: 'MMR-2', tree })).toBe(false);
    expect(runInScope(run, 'MMR', { id: 'MMR-2', tree: undefined })).toBe(false);
  });

  it('scopes the activity read to a run or null', () => {
    expect(scopedRun(undefined, 'MMR')).toBeNull();
    expect(scopedRun({ running: null }, 'MMR')).toBeNull();
    expect(scopedRun(runningActivity(), 'MMR')?.task).toBe('MMR-640');
    expect(scopedRun(runningActivity(), 'OTH')).toBeNull();
  });
});

describe('resetText', () => {
  it('reads the reset in the reader’s zone and names the budget day’s zone', () => {
    expect(resetText(new Date('2026-06-02T04:00:00.000Z'), 'America/New_York')).toBe(
      '12:00 AM (midnight America/New_York)',
    );
  });
});

describe('sharePercent', () => {
  it('clamps to 0-100 and survives a zero total', () => {
    expect(sharePercent(24, 100)).toBe(24);
    expect(sharePercent(150, 100)).toBe(100);
    expect(sharePercent(-1, 100)).toBe(0);
    expect(sharePercent(5, 0)).toBe(0);
  });
});
