import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoticeHost, toast } from '../components/patterns/notice';
import { NoticeBanner } from '../components/patterns/notice-banner';

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  vi.useRealTimers();
});

/** Whether a toast titled `text` is on screen, not only in the live region's copy of it. */
const shown = (text: string) =>
  screen.queryAllByText(text).some((node) => node.closest('[data-slot="toast-title"]') !== null);

describe('Notice toast', () => {
  it('shows a message and its kind helpers with the same call shape as Sonner', async () => {
    render(<NoticeHost />);
    act(() => {
      toast.success('Saved');
      toast.error('It broke', { description: 'Try later' });
    });
    await expect(screen.findByText('Saved')).resolves.toBeInTheDocument();
    expect(screen.getByText('It broke')).toBeInTheDocument();
    expect(screen.getByText('Try later')).toBeInTheDocument();
  });

  it('runs the action once and dismisses the toast', async () => {
    const onClick = vi.fn();
    render(<NoticeHost />);
    act(() => {
      toast('Archived Mimir', { action: { label: 'Undo', onClick } });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByText('Archived Mimir')).toBeNull();
    });
  });

  it('a toast with a Retry action offers it on an error', async () => {
    const onClick = vi.fn();
    render(<NoticeHost />);
    act(() => {
      toast.error('T3 did not answer.', { action: { label: 'Retry', onClick } });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('Dismiss closes it without running the action', async () => {
    const onClick = vi.fn();
    render(<NoticeHost />);
    act(() => {
      toast('Archived Mimir', { action: { label: 'Undo', onClick } });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.queryByText('Archived Mimir')).toBeNull();
    });
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Notice banner', () => {
  it('renders in place with role status, its text, and its action', async () => {
    const onClick = vi.fn();
    render(
      <NoticeBanner action={{ label: 'Refresh now', onClick }}>
        A new version is ready.
      </NoticeBanner>,
    );
    const banner = screen.getByText('A new version is ready.').closest('[role="status"]');
    expect(banner).toHaveTextContent('A new version is ready.');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Notice second button', () => {
  it('runs a cancel button once and dismisses the toast', async () => {
    const onClick = vi.fn();
    render(<NoticeHost />);
    act(() => {
      toast.warning('Not told', { cancel: { label: 'Reconnect T3', onClick } });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect T3' }));
    expect(onClick).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByText('Not told')).toBeNull();
    });
  });
});

/** Whether a live region of `politeness` says `text`. */
const said = (politeness: string, text: string) =>
  [...document.querySelectorAll(`[aria-live="${politeness}"]`)].some((region) =>
    region.textContent?.includes(text),
  );

describe('Notice timing and answers', () => {
  it('an action that returns a promise keeps the toast, pending, until it settles, and runs once', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const onClick = vi.fn(async () => promise);
    render(<NoticeHost />);
    act(() => {
      toast.error('Couldn’t save', { action: { label: 'Retry', onClick } });
    });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    await userEvent.click(retry);
    await userEvent.click(retry);
    expect(onClick).toHaveBeenCalledOnce();
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(shown('Couldn’t save')).toBe(true);
    await act(async () => {
      resolve();
      await promise;
    });
    await waitFor(() => {
      expect(shown('Couldn’t save')).toBe(false);
    });
  });

  it('holds for its duration, past the five-second default', async () => {
    vi.useFakeTimers();
    render(<NoticeHost />);
    act(() => {
      toast('Archived Mimir', { duration: 10_000 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    expect(shown('Archived Mimir')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(shown('Archived Mimir')).toBe(false);
  });

  it('closes after five seconds by default', async () => {
    vi.useFakeTimers();
    render(<NoticeHost />);
    act(() => {
      toast('Plain');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(shown('Plain')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(shown('Plain')).toBe(false);
  });

  it('announces an error at once and a success politely', async () => {
    render(<NoticeHost />);
    act(() => {
      toast.error('It broke');
      toast.success('Saved');
    });
    await waitFor(() => {
      expect(said('assertive', 'It broke')).toBe(true);
    });
    await waitFor(() => {
      expect(said('polite', 'Saved')).toBe(true);
    });
    expect(said('assertive', 'Saved')).toBe(false);
  });

  it('dismiss(id) closes only that toast', async () => {
    render(<NoticeHost />);
    let first = '';
    act(() => {
      first = toast('One');
      toast('Two');
    });
    await screen.findAllByText('Two');
    act(() => {
      toast.dismiss(first);
    });
    await waitFor(() => {
      expect(shown('One')).toBe(false);
    });
    expect(shown('Two')).toBe(true);
  });

  it('a toast raised before the host mounts shows once it mounts', async () => {
    act(() => {
      toast.success('Early');
    });
    render(<NoticeHost />);
    await expect(screen.findByText('Early')).resolves.toBeInTheDocument();
  });

  it('a second button runs once and leaves the action unrun', async () => {
    const action = vi.fn();
    const cancel = vi.fn();
    render(<NoticeHost />);
    act(() => {
      toast('Both', {
        action: { label: 'Undo', onClick: action },
        cancel: { label: 'Open thread', onClick: cancel },
      });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Open thread' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
  });
});
