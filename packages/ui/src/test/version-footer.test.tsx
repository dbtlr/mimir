import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VersionFooter } from '../components/version-footer';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));
vi.mock('../lib/build-version', () => ({ BUILD_VERSION: '0.13.0-next.68' }));

afterEach(() => {
  vi.clearAllMocks();
});

function renderFooter() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <VersionFooter />
    </QueryClientProvider>,
  );
}

describe('versionFooter (MMR-260)', () => {
  it('renders the daemon-reported version once /api/health answers', async () => {
    apiGet.mockResolvedValue({ schema: 4, status: 'ok', version: '0.13.0-next.68' });
    renderFooter();
    await expect(screen.findByText('0.13.0-next.68')).resolves.toBeDefined();
    expect(screen.queryByText(/update available/)).toBeNull();
  });

  it('renders the bundle version before the daemon answers', () => {
    apiGet.mockResolvedValue({ schema: 4, status: 'ok', version: '0.14.0-next.3' });
    renderFooter();
    // synchronous assertion: the query is still pending, so the fallback
    // (the bundle's own version) is on screen, not the not-yet-fetched daemon's.
    expect(screen.getByText('0.13.0-next.68')).toBeDefined();
  });

  it('flags a stale bundle when the daemon reports a different version', async () => {
    apiGet.mockResolvedValue({ schema: 4, status: 'ok', version: '0.14.0-next.3' });
    renderFooter();
    await expect(screen.findByText('0.14.0-next.3')).resolves.toBeDefined();
    expect(screen.getByText(/update available/)).toBeDefined();
  });
});
