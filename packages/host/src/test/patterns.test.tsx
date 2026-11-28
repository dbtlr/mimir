import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ContentSheet, ContentSheetClose } from '../components/patterns/content-sheet';
import { DestructiveConfirm } from '../components/patterns/destructive-confirm';
import { NavigationDrawer } from '../components/patterns/navigation-drawer';
import { useFinalFocus } from '../components/patterns/opener';
import { Reason } from '../components/patterns/reason';
import type { ReasonCommit } from '../components/patterns/reason';
import { ActionButton } from '../components/ui/action-button';
import { pressAndDropFocus } from './press-and-drop-focus';

/** A page with an opener, so focus return has somewhere to land. */
function ConfirmHarness({ onConfirm }: { onConfirm: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton onClick={() => setOpen(true)}>Open</ActionButton>
      <DestructiveConfirm
        open={open}
        onClose={() => setOpen(false)}
        title="Remove it?"
        commitLabel="Remove"
        onConfirm={onConfirm}
      >
        It cannot be undone.
      </DestructiveConfirm>
    </>
  );
}

function ReasonHarness({
  commits,
  required = false,
  closeOnCommit = true,
}: {
  commits: ReasonCommit[];
  required?: boolean;
  closeOnCommit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton onClick={() => setOpen(true)}>Open</ActionButton>
      <Reason
        open={open}
        onClose={() => setOpen(false)}
        title="Park it"
        label="Reason"
        placeholder="Say why"
        required={required}
        closeOnCommit={closeOnCommit}
        commits={commits}
      />
    </>
  );
}

/** A promise a test settles by hand. */
const deferred = () => Promise.withResolvers<void>();

/** A confirm that already holds an answer in place of its question. */
function Answered() {
  return (
    <DestructiveConfirm
      open
      onClose={() => undefined}
      title="Stop it?"
      commitLabel="Stop"
      answer="Already finishing."
      onConfirm={() => undefined}
    >
      Question text.
    </DestructiveConfirm>
  );
}

describe('DestructiveConfirm', () => {
  it('opens an alert dialog on Cancel and returns focus to the opener on Escape', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Remove it?',
    });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(dialog).toHaveTextContent('It cannot be undone.');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('carries the red hairline on its commit and calls onConfirm once', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const commit = within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Remove',
    });
    expect(commit.className).toContain('inset-ring-status-blocked');
    await userEvent.click(commit);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('blocks a second commit and holds the dialog open while the call is pending, then closes', async () => {
    const call = deferred();
    const onConfirm = vi.fn(() => call.promise);
    render(<ConfirmHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    call.resolve();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('stays open when the call fails, with the commit enabled again', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('refused'));
    render(<ConfirmHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeEnabled(),
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('disables Cancel while the call is pending', async () => {
    const call = deferred();
    render(<ConfirmHarness onConfirm={() => call.promise} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    call.resolve();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it.each([
    ['nothing', () => undefined],
    ['a promise', () => deferred().promise],
  ])('calls onConfirm once for two clicks in one task when it returns %s', async (_name, work) => {
    const onConfirm = vi.fn(work);
    render(<ConfirmHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const commit = within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Remove',
    });
    // Both clicks land before React flushes, so only the gate can hold the second.
    act(() => {
      commit.click();
      commit.click();
    });
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('treats a synchronous throw in onConfirm as a failure: the dialog stays and the commit is enabled', async () => {
    const onConfirm = vi.fn(() => {
      throw new Error('refused');
    });
    render(<ConfirmHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeEnabled(),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('takes focus back to the commit after a failed call dropped it', async () => {
    const call = deferred();
    render(<ConfirmHarness onConfirm={() => call.promise} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog');
    const commit = within(dialog).getByRole('button', { name: 'Remove' });
    pressAndDropFocus(commit);
    const refocus = vi.spyOn(commit, 'focus');
    call.reject(new Error('refused'));
    await waitFor(() => expect(refocus).toHaveBeenCalled());
    expect(commit).toHaveFocus();
  });

  it('restores dropped focus once the refused confirm is enabled again', async () => {
    const call = deferred();
    const confirm = (commitDisabled: boolean) => (
      <DestructiveConfirm
        open
        commitDisabled={commitDisabled}
        onClose={() => undefined}
        title="Remove it?"
        commitLabel="Remove"
        onConfirm={() => call.promise}
      >
        It cannot be undone.
      </DestructiveConfirm>
    );
    const { rerender } = render(confirm(false));
    const dialog = await screen.findByRole('alertdialog');
    const commit = within(dialog).getByRole('button', { name: 'Remove' });
    pressAndDropFocus(commit);
    expect(commit).toBeDisabled();
    rerender(confirm(true));
    const refocus = vi.spyOn(commit, 'focus');
    await settleCall(call, 'reject');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(commit).toBeDisabled();
    expect(refocus).not.toHaveBeenCalled();

    rerender(confirm(false));
    expect(commit).toBeEnabled();
    expect(refocus).toHaveBeenCalledOnce();
    expect(commit).toHaveFocus();
  });

  it('shows an answer in place of the question, with one Close that takes focus', async () => {
    render(<Answered />);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Already finishing.');
    expect(dialog).not.toHaveTextContent('Question text.');
    expect(within(dialog).queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});

describe('Reason', () => {
  it('opens on the text box, and returns focus to the opener on Escape', async () => {
    render(<ReasonHarness commits={[{ label: 'Park', onCommit: vi.fn() }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Park it' });
    expect(within(dialog).getByRole('textbox', { name: 'Reason' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  it('commits an empty optional reason, and a trimmed one when typed, then closes', async () => {
    const onCommit = vi.fn();
    render(<ReasonHarness commits={[{ label: 'Park', onCommit }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Park',
      }),
    );
    expect(onCommit).toHaveBeenLastCalledWith('');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox')).toHaveValue('');
    await userEvent.type(within(dialog).getByRole('textbox'), '  later  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Park' }));
    expect(onCommit).toHaveBeenLastCalledWith('later');
  });

  it('keeps every commit disabled until a required reason is non-blank', async () => {
    const onCommit = vi.fn();
    render(
      <ReasonHarness
        required
        commits={[
          { label: 'Confirm with note', onCommit },
          { label: 'Answer with note', onCommit },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    const first = within(dialog).getByRole('button', {
      name: 'Confirm with note',
    });
    const second = within(dialog).getByRole('button', {
      name: 'Answer with note',
    });
    expect(first).toBeDisabled();
    expect(second).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), '   ');
    expect(first).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'why');
    expect(second).toBeEnabled();
    await userEvent.click(second);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('why');
  });

  it('styles a destructive commit with the red hairline', async () => {
    render(
      <ReasonHarness
        commits={[
          {
            label: 'Abandon',
            onCommit: vi.fn(),
            variant: 'destructiveOutline',
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const commit = within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Abandon',
    });
    expect(commit.className).toContain('inset-ring-status-blocked');
  });

  it('holds the dialog while a commit is pending and blocks a second one', async () => {
    const call = deferred();
    const onCommit = vi.fn(() => call.promise);
    render(<ReasonHarness commits={[{ label: 'Park', onCommit }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    const commit = within(dialog).getByRole('button', { name: 'Park' });
    await userEvent.click(commit);
    expect(commit).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    call.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('keeps the reason read-only while a commit is pending', async () => {
    const call = deferred();
    render(<ReasonHarness commits={[{ label: 'Park', onCommit: () => call.promise }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    const reason = within(dialog).getByRole('textbox');
    await userEvent.type(reason, 'Wait for access');
    const commit = within(dialog).getByRole('button', { name: 'Park' });
    await userEvent.click(commit);
    expect(commit).toBeDisabled();

    await userEvent.type(reason, ' and review');
    expect(reason).toHaveAttribute('readonly');
    expect(reason).toHaveValue('Wait for access');
  });

  it('keeps the dialog and the text when a commit fails, and focuses the commit again', async () => {
    const onCommit = vi.fn().mockRejectedValueOnce(new Error('refused'));
    render(<ReasonHarness required commits={[{ label: 'Park', onCommit }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Wait for access');
    pressAndDropFocus(within(dialog).getByRole('button', { name: 'Park' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Park' })).toHaveFocus());
    expect(within(dialog).getByRole('textbox')).toHaveValue('Wait for access');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it.each([
    ['nothing', () => undefined],
    ['a promise', () => deferred().promise],
  ])('calls onCommit once for two clicks in one task when it returns %s', async (_name, work) => {
    const onCommit = vi.fn(work);
    render(<ReasonHarness closeOnCommit={false} commits={[{ label: 'Park', onCommit }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const commit = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Park' });
    act(() => {
      commit.click();
      commit.click();
    });
    expect(onCommit).toHaveBeenCalledOnce();
  });
});

/** An opener and a closer outside the dialog, so a test can close and reopen a held one. */
function Reopenable({ children }: { children: (open: boolean, close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Force close
      </button>
      {children(open, () => setOpen(false))}
    </>
  );
}

describe('reopening a dialog whose commit never settled', () => {
  it('DestructiveConfirm: the new opening is not busy, and the old settle is ignored', async () => {
    const never = deferred();
    const onConfirm = vi.fn(() => never.promise);
    render(
      <Reopenable>
        {(open, close) => (
          <DestructiveConfirm
            open={open}
            onClose={close}
            title="Remove it?"
            commitLabel="Remove"
            onConfirm={onConfirm}
          >
            It cannot be undone.
          </DestructiveConfirm>
        )}
      </Reopenable>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const first = await screen.findByRole('alertdialog');
    fireEvent.click(within(first).getByRole('button', { name: 'Remove' }));
    expect(within(first).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Force close' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeEnabled(),
    );
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    // The earlier opening settles late; it must not close the new one.
    await act(async () => {
      never.resolve();
      await never.promise;
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('Reason: the new opening is not busy, and the old settle is ignored', async () => {
    const never = deferred();
    const onCommit = vi.fn(() => never.promise);
    render(
      <Reopenable>
        {(open, close) => (
          <Reason
            open={open}
            onClose={close}
            title="Park it"
            commits={[{ label: 'Park', onCommit }]}
          />
        )}
      </Reopenable>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const first = await screen.findByRole('dialog');
    fireEvent.click(within(first).getByRole('button', { name: 'Park' }));
    expect(within(first).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Force close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Park' })).toBeEnabled());
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await act(async () => {
      never.resolve();
      await never.promise;
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

/** Two calls a test settles by hand, handed out in order: the first opening's, then the reopened one's. */
function inOrder() {
  const calls = [deferred(), deferred(), deferred()];
  let next = 0;
  const work = vi.fn(() => {
    const call = calls[next];
    next += 1;
    return call?.promise;
  });
  return { calls, work };
}

/** Settles `call` inside act, so the render it causes lands before the next assertion. */
async function settleCall(call: PromiseWithResolvers<void>, how: 'resolve' | 'reject') {
  await act(async () => {
    if (how === 'resolve') {
      call.resolve();
    } else {
      call.reject(new Error('refused'));
    }
    await call.promise.catch(() => undefined);
  });
}

/**
 * Opens the dialog, starts a commit that does not settle, closes the dialog from outside, and
 * opens it again; returns the reopened dialog once its commit is enabled.
 */
async function holdCloseReopen(role: 'alertdialog' | 'dialog', commitName: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  const first = await screen.findByRole(role);
  fireEvent.click(within(first).getByRole('button', { name: commitName }));
  fireEvent.click(screen.getByRole('button', { name: 'Force close' }));
  await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  const dialog = await screen.findByRole(role);
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: commitName })).toBeEnabled(),
  );
  return dialog;
}

function renderReopenableConfirm(onConfirm: () => Promise<void> | undefined, onClose = vi.fn()) {
  render(
    <Reopenable>
      {(open, close) => (
        <DestructiveConfirm
          open={open}
          onClose={() => {
            onClose();
            close();
          }}
          title="Remove it?"
          commitLabel="Remove"
          onConfirm={onConfirm}
        >
          It cannot be undone.
        </DestructiveConfirm>
      )}
    </Reopenable>,
  );
}

function renderReopenableReason(onCommit: () => Promise<void> | undefined, onClose = vi.fn()) {
  render(
    <Reopenable>
      {(open, close) => (
        <Reason
          open={open}
          onClose={() => {
            onClose();
            close();
          }}
          title="Park it"
          commits={[{ label: 'Park', onCommit }]}
        />
      )}
    </Reopenable>,
  );
}

describe.each([
  ['DestructiveConfirm', 'alertdialog', 'Remove', renderReopenableConfirm],
  ['Reason', 'dialog', 'Park', renderReopenableReason],
] as const)('%s reopened while its first commit never settled', (_name, role, commitName, show) => {
  it("runs the commit on the reopened dialog, and closes on that commit's own settle", async () => {
    const { calls, work } = inOrder();
    const onClose = vi.fn();
    show(work, onClose);
    const dialog = await holdCloseReopen(role, commitName);
    onClose.mockClear();
    fireEvent.click(within(dialog).getByRole('button', { name: commitName }));
    expect(work).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // The first opening's call settles first: the reopened dialog stays, still busy.
    await settleCall(calls[0]!, 'resolve');
    expect(screen.getByRole(role)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await settleCall(calls[1]!, 'resolve');
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays usable when the reopened dialog's commit is refused", async () => {
    const { calls, work } = inOrder();
    show(work);
    const dialog = await holdCloseReopen(role, commitName);
    const commit = within(dialog).getByRole('button', { name: commitName });
    pressAndDropFocus(commit);
    expect(work).toHaveBeenCalledTimes(2);
    const refocus = vi.spyOn(commit, 'focus');
    await settleCall(calls[1]!, 'reject');
    await waitFor(() => expect(commit).toBeEnabled());
    expect(refocus).toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.click(commit);
    expect(work).toHaveBeenCalledTimes(3);
  });
});

/**
 * The grooming answer's shape: a commit that returns nothing and starts the
 * caller's own call, which the caller reports through `pending`. "Refuse",
 * outside the dialog, ends the call.
 */
function CallerPendingReason({ onCommit }: { onCommit: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setPending(false)}>
        Refuse
      </button>
      <Reason
        open
        onClose={() => undefined}
        title="Answer"
        closeOnCommit={false}
        pending={pending}
        commits={[
          {
            label: 'Answer',
            onCommit: () => {
              onCommit();
              setPending(true);
            },
          },
        ]}
      />
    </>
  );
}

/** Commits, then refuses the call once the browser dropped focus. */
async function refuseCallerPending(onCommit: () => void = () => undefined) {
  render(<CallerPendingReason onCommit={onCommit} />);
  const dialog = await screen.findByRole('dialog');
  const commit = within(dialog).getByRole('button', { name: 'Answer' });
  pressAndDropFocus(commit);
  expect(commit).toBeDisabled();
  const refocus = vi.spyOn(commit, 'focus');
  // A dispatched click, which moves no focus; the modal dialog hides the button from roles.
  fireEvent.click(screen.getByText('Refuse'));
  await waitFor(() => expect(commit).toBeEnabled());
  return { commit, refocus };
}

describe('Reason with a caller-managed pending call', () => {
  it('returns focus to the commit when the call is refused', async () => {
    const { commit, refocus } = await refuseCallerPending();
    await waitFor(() => expect(refocus).toHaveBeenCalled());
    expect(commit).toHaveFocus();
  });

  it('runs the commit again after the call is refused', async () => {
    const onCommit = vi.fn();
    const { commit } = await refuseCallerPending(onCommit);
    fireEvent.click(commit);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});

describe('Reason refusals', () => {
  it('returns focus to the commit after each of two consecutive refusals', async () => {
    const calls = [deferred(), deferred()];
    let next = 0;
    const onCommit = vi.fn(() => {
      const call = calls[next];
      next += 1;
      return call?.promise;
    });
    render(<ReasonHarness commits={[{ label: 'Park', onCommit }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    const commit = within(dialog).getByRole('button', { name: 'Park' });
    const refocus = vi.spyOn(commit, 'focus');
    for (const [attempt, call] of calls.entries()) {
      pressAndDropFocus(commit);
      expect(onCommit).toHaveBeenCalledTimes(attempt + 1);
      refocus.mockClear();
      call.reject(new Error('refused'));
      await waitFor(() => expect(refocus).toHaveBeenCalledOnce());
      expect(commit).toHaveFocus();
    }
  });
});

async function refuseReasonOffline() {
  const call = deferred();
  const onCommit = vi.fn(() => call.promise);
  const reason = (open: boolean, commitDisabled: boolean) => (
    <Reason
      open={open}
      commitDisabled={commitDisabled}
      onClose={() => undefined}
      title="Park it"
      commits={[{ label: 'Park', onCommit }]}
    />
  );
  const { rerender } = render(reason(true, false));
  const dialog = await screen.findByRole('dialog');
  const text = within(dialog).getByRole('textbox');
  await userEvent.type(text, 'wait');
  const commit = within(dialog).getByRole('button', { name: 'Park' });
  pressAndDropFocus(commit);
  expect(onCommit).toHaveBeenCalledOnce();
  expect(commit).toBeDisabled();
  rerender(reason(true, true));
  const refocus = vi.spyOn(commit, 'focus');
  await settleCall(call, 'reject');
  expect(commit).toHaveAttribute('aria-busy', 'false');
  expect(commit).toBeDisabled();
  return { commit, onCommit, reason, refocus, rerender, text };
}

describe('Reason refusals while offline', () => {
  it('returns focus to the commit when it is enabled again', async () => {
    const { commit, refocus, rerender, reason } = await refuseReasonOffline();
    refocus.mockClear();
    rerender(reason(true, false));
    expect(commit).toBeEnabled();
    expect(refocus).toHaveBeenCalledOnce();
    expect(commit).toHaveFocus();
  });

  it('leaves focus alone while disabled and after closing before reconnection', async () => {
    const { refocus, rerender, reason } = await refuseReasonOffline();
    expect(refocus).not.toHaveBeenCalled();

    rerender(reason(false, true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    rerender(reason(false, false));
    expect(refocus).not.toHaveBeenCalled();
  });

  it('keeps focus on the reason being edited when the connection returns', async () => {
    const { onCommit, reason, rerender, text } = await refuseReasonOffline();
    await userEvent.type(text, ' for');
    expect(text).toHaveValue('wait for');
    rerender(reason(true, false));
    expect(text).toHaveFocus();

    await userEvent.keyboard(' access');
    expect(text).toHaveValue('wait for access');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('wait');
  });
});

/** Opens the hook with `opener` focused, and returns what it would focus on close. */
function resolveWith(opener: HTMLElement, change: () => void = () => undefined) {
  opener.focus();
  const { result, rerender } = renderHook(({ open }) => useFinalFocus(open, undefined), {
    initialProps: { open: false },
  });
  rerender({ open: true });
  change();
  const target = result.current;
  return typeof target === 'function' ? target() : target;
}

describe('useFinalFocus', () => {
  it('returns the opener while it is connected and enabled', () => {
    const opener = document.body.appendChild(document.createElement('button'));
    expect(resolveWith(opener)).toBe(opener);
    opener.remove();
  });

  it('finds nothing once the opener is disconnected', () => {
    const opener = document.body.appendChild(document.createElement('button'));
    expect(resolveWith(opener, () => opener.remove())).toBeNull();
  });

  it('finds nothing once the opener is disabled', () => {
    const opener = document.body.appendChild(document.createElement('button'));
    expect(
      resolveWith(opener, () => {
        opener.disabled = true;
      }),
    ).toBeNull();
    opener.remove();
  });
});

describe('ContentSheet', () => {
  it('closes on its one Done by default', async () => {
    const onClose = vi.fn();
    render(
      <ContentSheet open onClose={onClose} title="Android · Chrome">
        <p>Its switches</p>
      </ContentSheet>,
    );
    const sheet = await screen.findByRole('dialog', { name: 'Android · Chrome' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('takes a title with its key in mono, and the caller’s own footer actions', async () => {
    const onClose = vi.fn();
    const onOpen = vi.fn();
    render(
      <ContentSheet
        open
        onClose={onClose}
        title={
          <>
            <span className="font-mono">MMR-743</span> Form sheet pattern
          </>
        }
        actions={
          <>
            <ActionButton onClick={onOpen}>Open record</ActionButton>
            <ContentSheetClose>Close</ContentSheetClose>
          </>
        }
      >
        <p>The record’s preview</p>
      </ContentSheet>,
    );
    const sheet = await screen.findByRole('dialog', { name: 'MMR-743 Form sheet pattern' });
    expect(within(sheet).queryByRole('button', { name: 'Done' })).toBeNull();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Open record' }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/** The top bar's menu button and the drawer it opens, held open by the harness. */
function NavigationHarness({ onClosed }: { onClosed?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <NavigationDrawer
      open={open}
      onOpenChange={setOpen}
      onClosed={onClosed}
      triggerLabel="Open project menu"
      label="Project"
    >
      <nav aria-label="Project">
        <a href="#engine">Engine</a>
      </nav>
    </NavigationDrawer>
  );
}

describe('NavigationDrawer', () => {
  it('opens from the left as a modal dialog named by its label, on the sidebar’s surface', async () => {
    render(<NavigationHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project' });
    expect(drawer).toHaveAttribute('data-side', 'left');
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(drawer).toHaveClass('bg-well-950', 'p-3');
    expect(within(drawer).getByRole('link', { name: 'Engine' })).toBeInTheDocument();
  });

  it('closes on Escape, hands focus back to the menu button, then reports the close', async () => {
    const onClosed = vi.fn();
    render(<NavigationHarness onClosed={onClosed} />);
    const menu = screen.getByRole('button', { name: 'Open project menu' });
    await userEvent.click(menu);
    await screen.findByRole('dialog', { name: 'Project' });

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(menu).toHaveFocus();
    await waitFor(() => {
      expect(onClosed).toHaveBeenCalledOnce();
    });
  });

  it('closes on the scrim', async () => {
    render(<NavigationHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open project menu' }));
    await screen.findByRole('dialog', { name: 'Project' });

    await userEvent.click(screen.getByTestId('navigation-drawer-scrim'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
