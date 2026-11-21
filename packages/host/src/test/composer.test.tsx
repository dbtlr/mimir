import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from '../components/patterns/composer';
import type { ComposerProps } from '../components/patterns/composer';
import { pressAndDropFocus } from './press-and-drop-focus';

/** A promise a test settles by hand. */
const deferred = () => Promise.withResolvers<void>();

function renderComposer(props: Partial<ComposerProps> = {}) {
  const onCommit = props.onCommit ?? vi.fn();
  const view = render(
    <Composer
      label="Add a note"
      commitLabel="Append"
      commitName="Append note"
      onCommit={onCommit}
      {...props}
    />,
  );
  return {
    ...view,
    box: screen.getByRole('textbox', { name: 'Add a note' }),
    commit: screen.getByRole('button', { name: 'Append note' }),
    onCommit,
  };
}

describe('Composer', () => {
  it('is an inline text box that starts one line tall and grows', () => {
    const { box } = renderComposer();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(box).toHaveAttribute('rows', '1');
    expect(box.className).toContain('max-h-[110px]');
  });

  it('keeps the commit disabled until the text is non-blank, then commits it trimmed', async () => {
    const { box, commit, onCommit } = renderComposer();
    expect(commit).toBeDisabled();
    await userEvent.type(box, '   ');
    expect(commit).toBeDisabled();
    await userEvent.type(box, 'found a bug  ');
    expect(commit).toBeEnabled();
    await userEvent.click(commit);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('found a bug');
  });

  it('empties the box once the commit resolves, and gives focus back to the box', async () => {
    const call = deferred();
    const { box, commit } = renderComposer({ onCommit: () => call.promise });
    await userEvent.type(box, 'found a bug');
    pressAndDropFocus(commit);
    expect(box).toHaveValue('found a bug');
    await act(async () => {
      call.resolve();
      await call.promise;
    });
    await waitFor(() => expect(box).toHaveValue(''));
    expect(box).toHaveFocus();
    expect(commit).toBeDisabled();
  });

  it('holds the text read-only and the commit busy while the commit is pending, and runs it once', async () => {
    const call = deferred();
    const onCommit = vi.fn(() => call.promise);
    const { box, commit } = renderComposer({ onCommit });
    await userEvent.type(box, 'wait');
    act(() => {
      commit.click();
      commit.click();
    });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(commit).toBeDisabled();
    expect(commit).toHaveAttribute('aria-busy', 'true');
    expect(box).toHaveAttribute('readonly');
    await userEvent.type(box, ' more');
    expect(box).toHaveValue('wait');
    await act(async () => {
      call.resolve();
      await call.promise;
    });
  });

  it('keeps the text after a refusal and returns focus to the commit', async () => {
    const onCommit = vi.fn().mockRejectedValueOnce(new Error('refused'));
    const { box, commit } = renderComposer({ onCommit });
    await userEvent.type(box, 'found a bug');
    pressAndDropFocus(commit);
    await waitFor(() => expect(commit).toHaveFocus());
    expect(box).toHaveValue('found a bug');
    expect(box).not.toHaveAttribute('readonly');
    await userEvent.click(commit);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('is inert while disabled, as offline: neither the box nor the commit takes input', () => {
    const { box, commit } = renderComposer({ disabled: true });
    expect(box).toBeDisabled();
    expect(commit).toBeDisabled();
  });

  it('holds a typed commit while disabled and keeps the text', async () => {
    const onCommit = vi.fn();
    const { box, commit, rerender } = renderComposer({ onCommit });
    await userEvent.type(box, 'later');
    rerender(
      <Composer
        label="Add a note"
        commitLabel="Append"
        commitName="Append note"
        onCommit={onCommit}
        disabled
      />,
    );
    expect(commit).toBeDisabled();
    expect(box).toHaveValue('later');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
