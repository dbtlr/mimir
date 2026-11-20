import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoticeHost, toast } from '../components/patterns/notice';
import { NoticeBanner } from '../components/patterns/notice-banner';

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
});

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
