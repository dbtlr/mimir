import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groomPanel, startGroom } from '../api/fns/agent';
import type { GroomPanel, GroomRefusal, GroomStartResult } from '../api/fns/agent';
import { GroomWithAgentCard } from '../components/agent-card';
import { agentBudget, agentRun, endedRun, readyPanel } from './agent-fixtures';
import { serveAgent } from './agent-fns';
import { engineContainer, engineTask } from './node-fixtures';
import { renderInRouter } from './router';

vi.mock('../api/fns/agent');

// Mon Oct 12 2026, 18:00 in the suite's pinned zone (America/New_York).
const NOW = Date.parse('2026-10-12T22:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const task = (overrides: Partial<EngineNode> = {}) =>
  engineTask({ grooming: 'not_groomed', id: 'MMR-640', status: 'ready', ...overrides });

async function show(panel: GroomPanel, node = task(), offline = false, client?: QueryClient) {
  const state = serveAgent({ panel });
  const rendered = await renderInRouter(
    <GroomWithAgentCard node={node} offline={offline} />,
    client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return { ...rendered, state };
}

const card = () => screen.findByRole('region', { name: 'Groom with agent' });
const button = (name: string) => screen.getByRole('button', { name });

describe('hidden cases', () => {
  it('shows nothing while the runtime is unconfigured', async () => {
    await show({ state: 'unconfigured' });
    await waitFor(() => {
      expect(groomPanel).toHaveBeenCalled();
    });
    expect(screen.queryByRole('region', { name: 'Groom with agent' })).toBeNull();
  });

  it.each([
    ['a started task', task({ lifecycle: 'in_progress', status: 'in_progress' })],
    ['a container', engineContainer({ status: 'ready', type: 'phase' })],
  ])('shows nothing, and asks nothing, on %s', async (_name, node) => {
    await show(readyPanel(), node);
    expect(screen.queryByRole('region', { name: 'Groom with agent' })).toBeNull();
    expect(groomPanel).not.toHaveBeenCalled();
  });
});

describe('ready', () => {
  it('explains the run, offers the one solid button, and shows the budget with the reservation', async () => {
    await show(readyPanel());
    const region = await card();
    expect(within(region).getByText('claude-opus-5-5')).toBeVisible();
    expect(within(region).getByText(/never changes status/)).toBeVisible();
    expect(within(region).getByText('2.4M of 10M used today · this run reserves 4M')).toBeVisible();
    expect(within(region).getByText('resets 8:00 PM')).toBeVisible();
    expect(button('Groom with agent')).toBeEnabled();
  });

  it('shows the token file’s age, since a setup-token token lasts one year', async () => {
    await show(readyPanel({ tokenModifiedAt: new Date(Date.now() - 41 * 24 * 60 * 60 * 1000) }));
    expect(within(await card()).getByText(/Token file updated 5w ago/)).toBeVisible();
  });

  it('asks for the panel of this task in its project', async () => {
    await show(readyPanel());
    await card();
    expect(groomPanel).toHaveBeenCalledWith({ data: { project: 'MMR', task: 'MMR-640' } });
  });

  it('disables the button while the page is offline', async () => {
    await show(readyPanel(), task(), true);
    await card();
    expect(button('Groom with agent')).toBeDisabled();
  });
});

describe('the runtime off', () => {
  it('names the setting and problem when misconfigured, with no button', async () => {
    await show({ problem: 'unset', setting: 'MIMIR_HOSTS', state: 'misconfigured' });
    const region = await card();
    expect(region).toHaveTextContent('MIMIR_HOSTS is unset');
    expect(within(region).queryByRole('button')).toBeNull();
  });

  it('says to replace the token file when the token is refused', async () => {
    await show({ reason: 'rejected', state: 'disconnected' });
    const region = await card();
    expect(region).toHaveTextContent(/Replace the file MIMIR_AGENT_TOKEN_FILE names/);
    expect(within(region).queryByRole('button')).toBeNull();
  });
});

describe('a run', () => {
  it('shows a live run on this task with its age and tokens, and no button', async () => {
    await show(readyPanel({ running: agentRun({ startedAt: minutesAgo(2) }) }));
    const region = await card();
    expect(region).toHaveTextContent('Agent grooming');
    expect(region).toHaveTextContent('Started 2m ago');
    expect(region).toHaveTextContent('0.36M of its 4M ceiling');
    expect(within(region).queryByRole('button')).toBeNull();
  });

  it('says a stale run stopped reporting and will be marked interrupted', async () => {
    await show(readyPanel({ running: agentRun({ heartbeatAt: minutesAgo(3), stale: true }) }));
    const region = await card();
    expect(region).toHaveTextContent('Agent stopped reporting');
    expect(region).toHaveTextContent(/stopped reporting 3m ago/);
    expect(region).toHaveTextContent(/marked interrupted at the next start or boot/);
  });

  it('is busy when the run is on another task, with a link to it and a disabled button', async () => {
    await show(readyPanel({ running: agentRun({ startedAt: minutesAgo(3), task: 'MMR-612' }) }));
    const region = await card();
    expect(within(region).getByRole('link', { name: 'MMR-612' })).toHaveAttribute(
      'href',
      '/p/MMR/612',
    );
    expect(button('Groom with agent')).toBeDisabled();
  });
});

describe('no start', () => {
  it('says the project has no remote, with the button off', async () => {
    await show(readyPanel({ hasRemote: false }));
    const region = await card();
    expect(region).toHaveTextContent(/MMR has none/);
    expect(region).toHaveTextContent(/project's settings/);
    expect(button('Groom with agent')).toBeDisabled();
  });

  it('says the budget is short, with what is used, the reservation, and the reset', async () => {
    await show(
      readyPanel({
        budget: agentBudget({ remainingTokens: 2_900_000, usedTokens: 7_100_000 }),
      }),
    );
    const region = await card();
    expect(region).toHaveTextContent('reserves 4M tokens and only 2.9M are left today');
    expect(region).toHaveTextContent('7.1M of 10M used today · this run reserves 4M');
    expect(region).toHaveTextContent('resets 8:00 PM');
    expect(button('Groom with agent')).toBeDisabled();
  });
});

describe('after a run', () => {
  it.each([
    ['failed', 'Last run failed', 'The remote refused the credentials.'],
    ['cancelled', 'Last run cancelled', 'Stopped by the operator.'],
    ['interrupted', 'Last run interrupted', 'The host restarted.'],
  ] as const)('a %s run shows its outcome and Try again', async (state, title, outcome) => {
    await show(readyPanel({ lastRun: endedRun(state, outcome, { endedAt: minutesAgo(4) }) }));
    const region = await card();
    expect(region).toHaveTextContent(title);
    expect(region).toHaveTextContent(outcome);
    expect(button('Try again')).toBeEnabled();
  });

  it('shrinks a groomed task to one line crediting a succeeded run', async () => {
    await show(
      readyPanel({
        lastRun: endedRun('succeeded', 'Groomed', { endedAt: minutesAgo(12) }),
      }),
      task({ grooming: 'groomed' }),
    );
    const region = await card();
    expect(region).toHaveTextContent('Agent set Groomed 12m ago · 0.37M tokens');
    expect(button('Groom again')).toBeEnabled();
  });

  it('says only Groomed when the grooming was set by hand', async () => {
    await show(readyPanel(), task({ grooming: 'groomed' }));
    const region = await card();
    expect(region).toHaveTextContent('Groomed');
    expect(region).not.toHaveTextContent('Agent set');
    expect(button('Groom again')).toBeEnabled();
  });

  it('points at the timeline when the agent stopped on a question', async () => {
    await show(
      readyPanel({ lastRun: endedRun('succeeded', 'Asked') }),
      task({ grooming: 'needs_answers' }),
    );
    const region = await card();
    expect(region).toHaveTextContent(
      'The agent stopped on a question; its question and recommended answer are in the timeline',
    );
    expect(button('Groom again')).toBeEnabled();
  });
});

describe('starting', () => {
  it('sends the project and task, then refreshes the card on a started run', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { state } = await show(readyPanel());
    await card();
    state.panel = readyPanel({ running: agentRun() });
    await user.click(button('Groom with agent'));
    expect(startGroom).toHaveBeenCalledWith({ data: { project: 'MMR', task: 'MMR-640' } });
    await expect(screen.findByText('Agent grooming')).resolves.toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables the button while the start is pending', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { state } = await show(readyPanel());
    await card();
    const gate = Promise.withResolvers<GroomStartResult>();
    vi.mocked(startGroom).mockReturnValue(gate.promise);
    await user.click(button('Groom with agent'));
    await waitFor(() => {
      expect(button('Groom with agent')).toBeDisabled();
    });
    gate.resolve(state.start);
    await waitFor(() => {
      expect(button('Groom with agent')).toBeEnabled();
    });
  });

  const refusals: [string, GroomRefusal, RegExp][] = [
    ['unconfigured', { reason: 'unconfigured' }, /not set up on this host/],
    [
      'misconfigured',
      { problem: 'not writable', reason: 'misconfigured', setting: 'MIMIR_DATA_DIR' },
      /MIMIR_DATA_DIR is not writable/,
    ],
    ['disconnected', { reason: 'disconnected' }, /token was refused/],
    [
      'managed-policy',
      { paths: ['/etc/claude-code/managed-settings.json'], reason: 'managed-policy' },
      /managed settings exist on the host \(\/etc\/claude-code\/managed-settings\.json\)/,
    ],
    ['task-not-found', { reason: 'task-not-found' }, /no longer exists/],
    ['task-not-todo', { lifecycle: 'done', reason: 'task-not-todo' }, /only a todo task.*done/i],
    ['no-remote', { reason: 'no-remote' }, /no remote/],
    [
      'budget',
      {
        dailyTokens: 10_000_000,
        reason: 'budget',
        resetsAt: new Date('2026-10-13T04:00:00.000Z'),
        runTokens: 4_000_000,
        usedTokens: 7_100_000,
      },
      /only 2\.9M are left today.*resets at 12:00 AM/,
    ],
    [
      'busy with a run',
      { reason: 'busy', running: { id: 'r', startedAt: minutesAgo(3), task: 'MMR-612' } },
      /grooming MMR-612 since 3m ago/,
    ],
    ['busy without a run', { reason: 'busy', running: null }, /Try again/],
  ];

  it.each(refusals)('shows the %s refusal as an alert', async (_name, refusal, pattern) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { state } = await show(readyPanel());
    await card();
    state.start = { refusal, state: 'refused' };
    await user.click(button('Groom with agent'));
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent(pattern);
  });

  it('clears the alert on the next attempt', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { state } = await show(readyPanel());
    await card();
    state.start = { refusal: { reason: 'task-not-found' }, state: 'refused' };
    await user.click(button('Groom with agent'));
    await screen.findByRole('alert');
    state.start = { runId: 'run-2', state: 'started' };
    await user.click(button('Groom with agent'));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

describe('polling', () => {
  it('refetches the panel every 5s while a run holds the slot', async () => {
    await show(readyPanel({ running: agentRun({ task: 'MMR-612' }) }));
    await card();
    expect(groomPanel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => {
      expect(groomPanel).toHaveBeenCalledTimes(2);
    });
  });

  it('does not poll while the slot is free', async () => {
    await show(readyPanel());
    await card();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(groomPanel).toHaveBeenCalledTimes(1);
  });

  it('refreshes the task’s record and notes once a run on it leaves running', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { state } = await show(readyPanel({ running: agentRun() }), task(), false, client);
    await screen.findByText('Agent grooming');
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['node', 'MMR-640'] });
    state.panel = readyPanel({ lastRun: endedRun('succeeded', 'Groomed') });
    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['node', 'MMR-640'] });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['node', 'MMR-640', 'annotations'] });
  });
});
