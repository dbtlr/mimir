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

import { DestructiveConfirm } from '../components/patterns/destructive-confirm';
import { useFinalFocus } from '../components/patterns/opener';
import { Reason } from '../components/patterns/reason';
import type { ReasonCommit } from '../components/patterns/reason';
import { ActionButton } from '../components/ui/action-button';

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
    await userEvent.click(commit);
    // A browser drops focus to the page when the focused button disables; jsdom does not, so
    // the test observes the pattern's own call to focus the commit again.
    commit.blur();
    const refocus = vi.spyOn(commit, 'focus');
    call.reject(new Error('refused'));
    await waitFor(() => expect(refocus).toHaveBeenCalled());
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

  it('keeps the dialog and the text when a commit fails, and focuses the commit again', async () => {
    const onCommit = vi.fn().mockRejectedValueOnce(new Error('refused'));
    render(<ReasonHarness required commits={[{ label: 'Park', onCommit }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Wait for access');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Park' }));
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
    await userEvent.click(commit);
    expect(work).toHaveBeenCalledTimes(2);
    // A browser drops focus when the focused button disables; jsdom keeps it.
    commit.blur();
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
  await userEvent.click(commit);
  expect(commit).toBeDisabled();
  // A browser drops focus when the focused button disables; jsdom keeps it.
  commit.blur();
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
    // The dialog's own focus handling can put focus back on a blurred button, so the test
    // observes the pattern's call to focus the commit, as the DestructiveConfirm one does.
    const refocus = vi.spyOn(commit, 'focus');
    for (const [attempt, call] of calls.entries()) {
      await userEvent.click(commit);
      expect(onCommit).toHaveBeenCalledTimes(attempt + 1);
      // A browser drops focus when the focused button disables; jsdom keeps it.
      commit.blur();
      refocus.mockClear();
      call.reject(new Error('refused'));
      await waitFor(() => expect(refocus).toHaveBeenCalledOnce());
      expect(commit).toHaveFocus();
    }
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
