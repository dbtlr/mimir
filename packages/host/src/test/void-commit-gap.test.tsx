import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelGroom } from '../api/fns/agent';
import { denyPairing } from '../api/fns/devices';
import { groom } from '../api/fns/nodes';
import { GroomingAnswerDialog } from '../components/grooming-answer-dialog';
import { StopRunDialog } from '../components/stop-run-dialog';
import { consoleRoutes } from '../router';
import { serveDevices } from './devices-fns';
import { renderRoute } from './router';
import { serveViews } from './views-fns';

/*
 * A commit that returns nothing starts the caller's mutation, whose pending
 * state renders a task later (TanStack Query notifies in a `setTimeout`). These
 * tests act in that gap: after the click, only microtasks run before the next
 * click, Enter, or Escape.
 */

vi.mock('../api/fns/agent');
vi.mock('../api/fns/nodes');
vi.mock('../api/fns/devices');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('sonner', () => ({ Toaster: () => null, toast }));

beforeEach(() => {
  serveViews();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Runs queued microtasks, and no timer. */
async function microtasks() {
  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve();
    }
  });
}

function withClient(children: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

/** A call that stays in flight until the test settles it. */
function inFlight<T>() {
  return Promise.withResolvers<T>();
}

async function stopRunDialog(onClose = vi.fn()) {
  render(
    withClient(
      <StopRunDialog
        target={{ runId: 'run-1', task: 'MMR-1', usedTokens: 10 }}
        onClose={onClose}
      />,
    ),
  );
  const dialog = await screen.findByRole('alertdialog');
  return { commit: within(dialog).getByRole('button', { name: 'Stop run' }), dialog, onClose };
}

async function groomingAnswerDialog(onClose = vi.fn()) {
  render(
    withClient(<GroomingAnswerDialog nodeId="MMR-1" question="Which store?" onClose={onClose} />),
  );
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByRole('textbox'), 'SQLite');
  await userEvent.click(within(dialog).getAllByRole('radio')[0]!);
  return { commit: within(dialog).getByRole('button', { name: 'Answer' }), dialog, onClose };
}

describe('Stop run, before the stop renders as pending', () => {
  it('sends one cancel for a second click, which finds the commit disabled', async () => {
    vi.mocked(cancelGroom).mockReturnValue(inFlight<never>().promise);
    const { commit } = await stopRunDialog();
    fireEvent.click(commit);
    await microtasks();
    expect(commit).toBeDisabled();
    fireEvent.click(commit);
    await microtasks();
    expect(cancelGroom).toHaveBeenCalledOnce();
  });

  it('holds Escape while the cancel is in flight', async () => {
    vi.mocked(cancelGroom).mockReturnValue(inFlight<never>().promise);
    const { commit, onClose } = await stopRunDialog();
    fireEvent.click(commit);
    await microtasks();
    fireEvent.keyDown(commit, { key: 'Escape' });
    await microtasks();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('the grooming answer, before the answer renders as pending', () => {
  it('disables the grooming choices as soon as the answer starts saving', async () => {
    vi.mocked(groom).mockReturnValue(inFlight<never>().promise);
    const { commit, dialog } = await groomingAnswerDialog();
    const choices = within(dialog).getAllByRole('radio');
    for (const choice of choices) {
      expect(choice).toBeEnabled();
    }

    fireEvent.click(commit);
    expect(commit).toBeDisabled();
    for (const choice of choices) {
      expect(choice).toBeDisabled();
    }
  });

  it('saves one note for a second click', async () => {
    vi.mocked(groom).mockReturnValue(inFlight<never>().promise);
    const { commit } = await groomingAnswerDialog();
    fireEvent.click(commit);
    await microtasks();
    expect(commit).toBeDisabled();
    fireEvent.click(commit);
    await microtasks();
    expect(groom).toHaveBeenCalledOnce();
  });

  it('saves one note for Enter on the commit', async () => {
    vi.mocked(groom).mockReturnValue(inFlight<never>().promise);
    const user = userEvent.setup({ delay: null });
    const { commit } = await groomingAnswerDialog();
    commit.focus();
    fireEvent.click(commit);
    await microtasks();
    await user.keyboard('{Enter}');
    await microtasks();
    expect(groom).toHaveBeenCalledOnce();
  });

  it('holds Escape while the answer is in flight', async () => {
    vi.mocked(groom).mockReturnValue(inFlight<never>().promise);
    const { commit, onClose } = await groomingAnswerDialog();
    fireEvent.click(commit);
    await microtasks();
    fireEvent.keyDown(commit, { key: 'Escape' });
    await microtasks();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('runs the answer again after a refusal, with focus back on the commit', async () => {
    vi.mocked(groom).mockRejectedValueOnce(new Error('Host refused.'));
    const { commit } = await groomingAnswerDialog();
    await userEvent.click(commit);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Host refused.'));
    await waitFor(() => expect(commit).toBeEnabled());
    expect(commit).toHaveFocus();
    vi.mocked(groom).mockReturnValue(inFlight<never>().promise);
    await userEvent.click(commit);
    expect(groom).toHaveBeenCalledTimes(2);
  });
});

describe('Deny on /pair, before the deny renders as pending', () => {
  const CODE = 'K7QM-2XRD';

  async function denyDialog() {
    const now = Date.now();
    serveDevices({
      codes: {
        [CODE]: {
          created_at: new Date(now - 60_000).toISOString(),
          device: 'drews-macbook',
          expires_at: new Date(now + 570_000).toISOString(),
          rotates: false,
        },
      },
    });
    await renderRoute(consoleRoutes, `/pair?code=${CODE}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Deny drews-macbook?' });
    vi.mocked(denyPairing).mockReturnValue(inFlight<never>().promise);
    return { commit: within(dialog).getByRole('button', { name: 'Deny' }), dialog };
  }

  it('denies once for a second click', async () => {
    const { commit } = await denyDialog();
    fireEvent.click(commit);
    await microtasks();
    expect(commit).toBeDisabled();
    fireEvent.click(commit);
    await microtasks();
    expect(denyPairing).toHaveBeenCalledOnce();
  });

  it('holds Escape while the deny is in flight', async () => {
    const { commit } = await denyDialog();
    fireEvent.click(commit);
    await microtasks();
    fireEvent.keyDown(commit, { key: 'Escape' });
    await microtasks();
    expect(screen.getByRole('alertdialog', { name: 'Deny drews-macbook?' })).toBeInTheDocument();
  });
});
