import { render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import { lazySheet } from '../components/lazy-sheet';

const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));

const noop = () => undefined;

function Sheet({ open }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <p>{open ? 'sheet open' : 'sheet closed'}</p>;
}

describe('lazySheet (MMR-583)', () => {
  it('mounts the sheet closed once it loads, so its first open can animate', async () => {
    const LazySheet = lazySheet(async () => Sheet);
    const { rerender } = render(<LazySheet open={false} onOpenChange={noop} />);
    await expect(screen.findByText('sheet closed')).resolves.toBeInTheDocument();
    rerender(<LazySheet open onOpenChange={noop} />);
    expect(screen.getByText('sheet open')).toBeInTheDocument();
  });

  it('loads the sheet once across opens and closes', async () => {
    const load = vi.fn(async () => Sheet);
    const LazySheet = lazySheet(load);
    const { rerender } = render(<LazySheet open onOpenChange={noop} />);
    await screen.findByText('sheet open');
    rerender(<LazySheet open={false} onOpenChange={noop} />);
    rerender(<LazySheet open onOpenChange={noop} />);
    expect(screen.getByText('sheet open')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('renders nothing in place of the sheet while it loads', () => {
    const { promise } = Promise.withResolvers<typeof Sheet>();
    const LazySheet = lazySheet(async () => promise);
    const { container } = render(<LazySheet open onOpenChange={noop} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('retries a failed load when the sheet next opens, leaving the page standing', async () => {
    const load = vi
      .fn<() => Promise<typeof Sheet>>()
      .mockRejectedValueOnce(new Error('chunk missing'))
      .mockResolvedValueOnce(Sheet);
    const LazySheet = lazySheet(load);
    const { container, rerender } = render(<LazySheet open={false} onOpenChange={noop} />);
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(1);
    });
    expect(container).toBeEmptyDOMElement();
    rerender(<LazySheet open onOpenChange={noop} />);
    await expect(screen.findByText('sheet open')).resolves.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('closes a sheet whose load failed while open, so the next open retries', async () => {
    const load = vi
      .fn<() => Promise<typeof Sheet>>()
      .mockRejectedValueOnce(new Error('chunk missing'))
      .mockResolvedValueOnce(Sheet);
    const onOpenChange = vi.fn();
    const LazySheet = lazySheet(load);
    const { rerender } = render(<LazySheet open onOpenChange={onOpenChange} />);
    await vi.waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/refresh/i));
    rerender(<LazySheet open={false} onOpenChange={onOpenChange} />);
    rerender(<LazySheet open onOpenChange={onOpenChange} />);
    await expect(screen.findByText('sheet open')).resolves.toBeInTheDocument();
  });
});
