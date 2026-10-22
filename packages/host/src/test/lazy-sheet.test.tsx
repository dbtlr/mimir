import { render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import { lazySheet } from '../components/lazy-sheet';

function Sheet({ open }: { open: boolean }) {
  return <p>{open ? 'sheet open' : 'sheet closed'}</p>;
}

describe('lazySheet (MMR-583)', () => {
  it('mounts the sheet closed once it loads, so its first open can animate', async () => {
    const LazySheet = lazySheet(async () => Sheet);
    const { rerender } = render(<LazySheet open={false} />);
    await expect(screen.findByText('sheet closed')).resolves.toBeInTheDocument();
    rerender(<LazySheet open />);
    expect(screen.getByText('sheet open')).toBeInTheDocument();
  });

  it('loads the sheet once across opens and closes', async () => {
    const load = vi.fn(async () => Sheet);
    const LazySheet = lazySheet(load);
    const { rerender } = render(<LazySheet open />);
    await screen.findByText('sheet open');
    rerender(<LazySheet open={false} />);
    rerender(<LazySheet open />);
    expect(screen.getByText('sheet open')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('renders nothing in place of the sheet while it loads', () => {
    const { promise } = Promise.withResolvers<typeof Sheet>();
    const LazySheet = lazySheet(async () => promise);
    const { container } = render(<LazySheet open />);
    expect(container).toBeEmptyDOMElement();
  });

  it('retries a failed load when the sheet next opens, leaving the page standing', async () => {
    const load = vi
      .fn<() => Promise<typeof Sheet>>()
      .mockRejectedValueOnce(new Error('chunk missing'))
      .mockResolvedValueOnce(Sheet);
    const LazySheet = lazySheet(load);
    const { container, rerender } = render(<LazySheet open={false} />);
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(1);
    });
    expect(container).toBeEmptyDOMElement();
    rerender(<LazySheet open />);
    await expect(screen.findByText('sheet open')).resolves.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
