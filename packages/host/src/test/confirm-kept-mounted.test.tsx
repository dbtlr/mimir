import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DestructiveConfirm } from '../components/patterns/destructive-confirm';
import type { AlertDialogContent } from '../components/ui/alert-dialog';
import { pressAndDropFocus } from './press-and-drop-focus';

/*
 * In a browser a Destructive confirm reopened during its exit transition keeps
 * its content, and so its commit button, mounted; jsdom has no transition, so
 * it unmounts at once. Keeping the content mounted while closed reproduces that
 * path here.
 */
vi.mock('../components/ui/alert-dialog', async (importOriginal) => {
  const original = await importOriginal<{ AlertDialogContent: typeof AlertDialogContent }>();
  return {
    ...original,
    AlertDialogContent: (props: ComponentProps<typeof original.AlertDialogContent>) => (
      <original.AlertDialogContent keepMounted {...props} />
    ),
  };
});

function Reopenable({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
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

describe('Destructive confirm reopened while its content stayed mounted', () => {
  it('opens on Cancel, not on the commit an earlier opening refused', async () => {
    const refused = Promise.withResolvers<void>();
    render(<Reopenable onConfirm={() => refused.promise} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog');
    const commit = within(dialog).getByRole('button', { name: 'Remove' });
    pressAndDropFocus(commit);
    await act(async () => {
      refused.reject(new Error('refused'));
      await refused.promise.catch(() => undefined);
    });
    await waitFor(() => expect(commit).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    const refocus = vi.spyOn(commit, 'focus');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const reopened = await screen.findByRole('alertdialog');
    expect(within(reopened).getByRole('button', { name: 'Remove' })).toBe(commit);
    await waitFor(() =>
      expect(within(reopened).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    );
    expect(refocus).not.toHaveBeenCalled();
  });
});
