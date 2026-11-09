import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelGroom, groomCard, startGroom } from '../api/fns/agent';
import type {
  GroomCancelResult,
  GroomCard,
  GroomRefusal,
  GroomStartResult,
} from '../api/fns/agent';
import { POLL_MS } from '../api/queries';
import { GroomWithAgentCard } from '../components/agent-card';
import { CONSOLE_CANCEL_OUTCOME } from '../server/agent-console-states';
import { agentBudget, agentRun, endedRun, readyCard } from './agent-fixtures';
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

async function show(answer: GroomCard, node = task(), offline = false, client?: QueryClient) {
  const state = serveAgent({ card: answer });
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
      expect(groomCard).toHaveBeenCalled();
    });
    expect(screen.queryByRole('region', { name: 'Groom with agent' })).toBeNull();
  });

  it.each([
    ['a started task', task({ lifecycle: 'in_progress', status: 'in_progress' })],
    ['a container', engineContainer({ status: 'ready', type: 'phase' })],
  ])('shows nothing, and asks nothing, on %s', async (_name, node) => {
    await show(readyCard(), node);
    expect(screen.queryByRole('region', { name: 'Groom with agent' })).toBeNull();
    expect(groomCard).not.toHaveBeenCalled();
  });
});

describe('ready', () => {
  it('explains the run, offers the one solid button, and shows the budget with the reservation', async () => {
    await show(readyCard());
    const region = await card();
    expect(within(region).getByText('claude-opus-5-5')).toBeVisible();
    expect(within(region).getByText(/never changes status/)).toBeVisible();
    expect(within(region).getByText('2.4M of 10M used today · this run reserves 4M')).toBeVisible();
    expect(within(region).getByText('resets 8:00 PM (midnight UTC)')).toBeVisible();
    expect(button('Groom with agent')).toBeEnabled();
  });

  it('shows the token file’s age, since a setup-token token lasts one year', async () => {
    await show(readyCard({ tokenModifiedAt: new Date(Date.now() - 41 * 24 * 60 * 60 * 1000) }));
    expect(within(await card()).getByText(/Token file updated 5w ago/)).toBeVisible();
  });

  it('asks for the card of this task in its project', async () => {
    await show(readyCard());
    await card();
    expect(groomCard).toHaveBeenCalledWith({ data: { project: 'MMR', task: 'MMR-640' } });
  });

  it('disables the button while the page is offline', async () => {
    await show(readyCard(), task(), true);
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

  it('says to replace the token file when the token is refused, with the file’s age', async () => {
    await show({
      reason: 'rejected',
      state: 'disconnected',
      tokenModifiedAt: new Date(NOW - 41 * 24 * 60 * 60 * 1000),
    });
    const region = await card();
    expect(region).toHaveTextContent(/Replace the file MIMIR_AGENT_TOKEN_FILE names/);
    expect(region).toHaveTextContent(/Token file updated 5w ago/);
    expect(within(region).queryByRole('button')).toBeNull();
  });

  it('names managed settings on the host before any click, with no button', async () => {
    await show({
      paths: ['/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-mcp.json'],
      state: 'managed-policy',
    });
    const region = await card();
    expect(region).toHaveTextContent('/etc/claude-code/managed-settings.json');
    expect(region).toHaveTextContent('/etc/claude-code/managed-mcp.json');
    expect(region).toHaveTextContent(/would override the run’s limits/);
    expect(within(region).queryByRole('button')).toBeNull();
  });
});

describe('a run', () => {
  it('shows a live run on this task with its age and tokens, and no button', async () => {
    await show(readyCard({ running: agentRun({ startedAt: minutesAgo(2) }) }));
    const region = await card();
    expect(region).toHaveTextContent('Agent grooming');
    expect(region).toHaveTextContent('Started 2m ago');
    expect(region).toHaveTextContent('0.36M of its 4M ceiling');
    expect(within(region).queryByRole('button')).toBeNull();
  });

  it('says a stale run on this task stopped reporting, and offers a start that recovers it', async () => {
    await show(readyCard({ running: agentRun({ heartbeatAt: minutesAgo(3), stale: true }) }));
    const region = await card();
    expect(region).toHaveTextContent('Agent stopped reporting');
    expect(region).toHaveTextContent(/stopped reporting 3m ago/);
    expect(region).toHaveTextContent(/A new start marks it interrupted/);
    expect(region).toHaveTextContent(
      /counts its reservation or its streamed usage, whichever is larger/,
    );
    expect(region).not.toHaveTextContent(/full reservation/);
    expect(button('Try again')).toBeEnabled();
  });

  it('is busy when the run is on another task, with a link to it and a disabled button', async () => {
    await show(readyCard({ running: agentRun({ startedAt: minutesAgo(3), task: 'MMR-612' }) }));
    const region = await card();
    expect(within(region).getByRole('link', { name: 'MMR-612' })).toHaveAttribute(
      'href',
      '/p/MMR/612',
    );
    expect(region).toHaveTextContent('An agent started grooming MMR-612 3m ago.');
    expect(button('Groom with agent')).toBeDisabled();
  });

  it('is not busy when the run on another task went stale: a start recovers the slot', async () => {
    await show(readyCard({ running: agentRun({ stale: true, task: 'MMR-612' }) }));
    const region = await card();
    expect(region).toHaveTextContent(/never changes status/);
    expect(button('Groom with agent')).toBeEnabled();
  });
});

describe('no start', () => {
  it('says the project has no remote, with the button off', async () => {
    await show(readyCard({ hasRemote: false }));
    const region = await card();
    expect(region).toHaveTextContent(/MMR has none/);
    // The console has no remote field; the CLI sets it.
    expect(region).toHaveTextContent('mimir update MMR --remote <url>');
    expect(button('Groom with agent')).toBeDisabled();
  });

  it('says the budget is short, with what is used, the reservation, and the reset', async () => {
    await show(
      readyCard({
        budget: agentBudget({ remainingTokens: 2_900_000, usedTokens: 7_100_000 }),
      }),
    );
    const region = await card();
    expect(region).toHaveTextContent('reserves 4M tokens and only 2.9M are left today');
    expect(region).toHaveTextContent('7.1M of 10M used today · this run reserves 4M');
    expect(region).toHaveTextContent('The budget resets at 8:00 PM (midnight UTC).');
    expect(region).toHaveTextContent('resets 8:00 PM (midnight UTC)');
    expect(button('Groom with agent')).toBeDisabled();
  });
});

describe('after a run', () => {
  it.each([
    ['failed', 'Last run failed', 'The remote refused the credentials.'],
    ['cancelled', 'Last run cancelled', 'Stopped by the operator.'],
    ['interrupted', 'Last run interrupted', 'The host restarted.'],
  ] as const)('a %s run shows its outcome and Try again', async (state, title, outcome) => {
    await show(readyCard({ lastRun: endedRun(state, outcome, { endedAt: minutesAgo(4) }) }));
    const region = await card();
    expect(region).toHaveTextContent(title);
    expect(region).toHaveTextContent(outcome);
    expect(button('Try again')).toBeEnabled();
  });

  // The run row records no write, so the card names the last run beside the
  // grooming without claiming the agent set it.
  it('shrinks a groomed task to one line naming the last agent run', async () => {
    await show(
      readyCard({
        lastRun: endedRun('succeeded', 'Groomed', { endedAt: minutesAgo(12) }),
      }),
      task({ grooming: 'groomed' }),
    );
    const region = await card();
    expect(region).toHaveTextContent('Groomed · last agent run 12m ago · 0.37M tokens');
    expect(region).not.toHaveTextContent('Agent set');
    expect(button('Groom again')).toBeEnabled();
  });

  it('says only Groomed when no agent run has ended', async () => {
    await show(readyCard(), task({ grooming: 'groomed' }));
    const region = await card();
    expect(region).toHaveTextContent('Groomed');
    expect(region).not.toHaveTextContent('last agent run');
    expect(button('Groom again')).toBeEnabled();
  });

  it('points at the timeline when the task needs answers after an agent run', async () => {
    await show(
      readyCard({ lastRun: endedRun('succeeded', 'Asked', { endedAt: minutesAgo(12) }) }),
      task({ grooming: 'needs_answers' }),
    );
    const region = await card();
    expect(region).toHaveTextContent(
      'Needs answers. The last agent run ended 12m ago; its notes are in the timeline.',
    );
    expect(region).not.toHaveTextContent(/agent stopped on a question/i);
    expect(button('Groom again')).toBeEnabled();
  });
});

describe('starting', () => {
  it('sends the project and task, then refreshes the card on a started run', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { state } = await show(readyCard());
    await card();
    state.card = readyCard({ running: agentRun() });
    await user.click(button('Groom with agent'));
    expect(startGroom).toHaveBeenCalledWith({ data: { project: 'MMR', task: 'MMR-640' } });
    await expect(screen.findByText('Agent grooming')).resolves.toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables the button while the start is pending', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { state } = await show(readyCard());
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
        timezone: 'America/New_York',
        usedTokens: 7_100_000,
      },
      /only 2\.9M are left today.*resets at 12:00 AM \(midnight America\/New_York\)/,
    ],
    [
      'busy with a run',
      { reason: 'busy', running: { id: 'r', startedAt: minutesAgo(3), task: 'MMR-612' } },
      /one started grooming MMR-612 3m ago\./,
    ],
    ['busy without a run', { reason: 'busy', running: null }, /Try again/],
  ];

  it.each(refusals)('shows the %s refusal as an alert', async (_name, refusal, pattern) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { state } = await show(readyCard());
    await card();
    state.start = { refusal, state: 'refused' };
    await user.click(button('Groom with agent'));
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent(pattern);
  });

  it('clears the alert on the next attempt', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { state } = await show(readyCard());
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
  it('refetches the card every 5s while a run holds the slot', async () => {
    await show(readyCard({ running: agentRun({ task: 'MMR-612' }) }));
    await card();
    expect(groomCard).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => {
      expect(groomCard).toHaveBeenCalledTimes(2);
    });
  });

  it('polls at the console’s default interval while the slot is free', async () => {
    await show(readyCard());
    await card();
    await vi.advanceTimersByTimeAsync(5000);
    expect(groomCard).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS - 5000);
    await waitFor(() => {
      expect(groomCard).toHaveBeenCalledTimes(2);
    });
  });

  it('polls at the default interval, not every 5s, while only a stale run holds the slot', async () => {
    await show(readyCard({ running: agentRun({ stale: true, task: 'MMR-612' }) }));
    await card();
    await vi.advanceTimersByTimeAsync(5000);
    expect(groomCard).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS - 5000);
    await waitFor(() => {
      expect(groomCard).toHaveBeenCalledTimes(2);
    });
  });

  it('refreshes the task’s record and notes once a run on it leaves running', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { state } = await show(readyCard({ running: agentRun() }), task(), false, client);
    await screen.findByText('Agent grooming');
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['node', 'MMR-640'] });
    state.card = readyCard({ lastRun: endedRun('succeeded', 'Groomed') });
    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['node', 'MMR-640'] });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['node', 'MMR-640', 'annotations'] });
  });

  it('refreshes the task’s record and notes when a run it never saw running has ended', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const earlier = endedRun('succeeded', 'Groomed', { id: 'run-1' });
    const { state } = await show(readyCard({ lastRun: earlier }), task(), false, client);
    await card();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // The same last run on a later read is nothing new.
    await waitFor(() => {
      expect(groomCard).toHaveBeenCalledTimes(2);
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['node', 'MMR-640'] });
    // A fast run, or one started from another tab, ended between two reads.
    state.card = readyCard({ lastRun: endedRun('failed', 'x', { id: 'run-2' }) });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['node', 'MMR-640'] });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['node', 'MMR-640', 'annotations'] });
  });
});

const cancellable = () => readyCard({ running: agentRun({ cancellable: true }) });

const openDialog = async (answer: GroomCancelResult = { state: 'cancelling' }) => {
  const shown = await show(cancellable());
  shown.state.cancel = answer;
  await card();
  await userEvent.click(button('Stop'));
  return screen.findByRole('dialog', { name: 'Stop the agent on MMR-640?' });
};

describe('stopping a run', () => {
  it('offers Stop only on a cancellable run', async () => {
    await show(readyCard({ running: agentRun() }));
    await card();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('offers Stop in the header bar of a cancellable run', async () => {
    await show(cancellable());
    expect(within(await card()).getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('opens the confirm on Keep running, saying what stops and what it costs', async () => {
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent(
      'It finishes the step it is on, then stops: usually seconds, at most 5 minutes.',
    );
    expect(dialog).toHaveTextContent(
      "Notes it already wrote stay on the task. The 0.36M tokens it has used so far count toward today's budget.",
    );
    expect(within(dialog).getByRole('button', { name: 'Keep running' })).toHaveFocus();
  });

  it('closes on Keep running without a call, and returns focus to Stop', async () => {
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(cancelGroom).not.toHaveBeenCalled();
    expect(button('Stop')).toHaveFocus();
  });

  it('closes on Escape without a call', async () => {
    await openDialog();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(cancelGroom).not.toHaveBeenCalled();
  });

  it('calls cancelGroom with the run id and closes on a recorded cancel', async () => {
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    await waitFor(() => {
      expect(cancelGroom).toHaveBeenCalledWith({ data: { runId: 'run-1' } });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it.each([
    [{ state: 'ending' }, 'The run is already finishing on its own.'],
    [{ runState: 'succeeded', state: 'ended' }, 'The run already ended (succeeded).'],
    [{ state: 'unknown' }, 'This run no longer exists.'],
    [{ state: 'stale' }, "The run's host stopped reporting. Starting a new run clears it."],
    [
      { state: 'closing' },
      'This host could not close the run. It will be cleared within two minutes.',
    ],
    [
      { state: 'another-host' },
      'Another host is running this. Try again shortly, or wait for it to finish.',
    ],
  ] as const)('keeps the dialog open and says what %j meant', async (answer, sentence) => {
    const dialog = await openDialog(answer);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));
    await expect(screen.findByText(sentence)).resolves.toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('refreshes the card whatever the answer', async () => {
    const dialog = await openDialog({ state: 'unknown' });
    expect(groomCard).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));
    await waitFor(() => {
      expect(groomCard).toHaveBeenCalledTimes(2);
    });
  });

  it('shows a stopping run with its own title and copy, no Stop, and the meter', async () => {
    await show(readyCard({ running: agentRun({ stopping: true }) }));
    const region = await card();
    expect(region).toHaveTextContent('Stopping the agent');
    expect(region).toHaveTextContent(
      'Stopping after its current step. This usually takes seconds, and at most 5 minutes.',
    );
    expect(region).toHaveTextContent('0.36M of its 4M ceiling');
    expect(within(region).queryByRole('button')).toBeNull();
  });

  it('says the operator stopped a run cancelled from the console', async () => {
    await show(
      readyCard({
        lastRun: endedRun('cancelled', `${CONSOLE_CANCEL_OUTCOME}; the agent had 2 notes`, {
          endedAt: minutesAgo(1),
        }),
      }),
    );
    const region = await card();
    expect(region).toHaveTextContent('Last run cancelled');
    expect(region).toHaveTextContent('You stopped this run 1m ago. Its notes stay on the task.');
    expect(region).toHaveTextContent('Used 0.37M tokens, counted toward today.');
    expect(region).not.toHaveTextContent('the operator stopped the run from the console');
  });

  it('keeps the outcome line for a run a ceiling cancelled', async () => {
    const outcome = 'cancelled: the run reached its 4M token ceiling';
    await show(readyCard({ lastRun: endedRun('cancelled', outcome, { endedAt: minutesAgo(4) }) }));
    const region = await card();
    expect(region).toHaveTextContent(outcome);
    expect(region).not.toHaveTextContent('You stopped this run');
  });
});
