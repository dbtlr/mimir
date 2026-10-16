import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { WireArtifactSummary } from '../api/types';
import { ArtifactList } from '../components/artifact-list';
import { renderInRouter } from './router';

// Fixed clock (date only — timers stay real for userEvent): Fri 2026-10-09.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

const artifact = (over: Partial<WireArtifactSummary> & { id: string }): WireArtifactSummary => ({
  created_at: new Date(2026, 9, 9, 9).toISOString(),
  links: [],
  project: 'MMR',
  tags: [],
  title: 'An artifact',
  ...over,
});

describe('artifactList', () => {
  it('groups rows under local-day headers, newest first', async () => {
    await renderInRouter(
      <ArtifactList
        items={[
          artifact({ id: 'MMR-a3', title: 'Today one' }),
          artifact({ created_at: new Date(2026, 9, 8, 9).toISOString(), id: 'MMR-a2' }),
          artifact({ created_at: new Date(2026, 9, 6, 9).toISOString(), id: 'MMR-a1' }),
        ]}
      />,
    );
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toStrictEqual(['Today', 'Yesterday', 'Oct 6']);
  });

  it("each row's title links to the artifact's own page", async () => {
    await renderInRouter(
      <ArtifactList items={[artifact({ id: 'MMR-a219', title: 'The spec' })]} />,
    );
    expect(screen.getByRole('link', { name: 'The spec' })).toHaveAttribute('href', '/p/MMR/a219');
  });

  it('shows each kind as a chip after the title, and the summary as the lede', async () => {
    await renderInRouter(
      <ArtifactList
        items={[
          artifact({
            id: 'MMR-a1',
            summary: 'What shipped today.',
            tags: ['kind:spec', 'doctor', 'session_summary'],
          }),
        ]}
      />,
    );
    expect(screen.getByText('spec')).toBeInTheDocument();
    expect(screen.getByText('session_summary')).toBeInTheDocument();
    expect(screen.queryByText('doctor')).toBeNull();
    expect(screen.getByText('What shipped today.')).toBeInTheDocument();
  });

  it('names the attached records as links to their pages', async () => {
    const { router } = await renderInRouter(
      <ArtifactList items={[artifact({ id: 'MMR-a1', links: ['MMR-450', 'MMR-s4'] })]} />,
    );
    const node = screen.getByRole('link', { name: 'MMR-450' });
    expect(node).toHaveAttribute('href', '/p/MMR/450');
    expect(node.className).toContain('z-10');
    expect(screen.getByRole('link', { name: 'MMR-s4' })).toHaveAttribute('href', '/p/MMR/s4');
    await userEvent.click(node);
    expect(router.state.location.pathname).toBe('/p/MMR/450');
  });

  it('shows three attached records, then +N', async () => {
    await renderInRouter(
      <ArtifactList
        items={[artifact({ id: 'MMR-a1', links: ['MMR-1', 'MMR-2', 'MMR-3', 'MMR-4', 'MMR-5'] })]}
      />,
    );
    expect(screen.getByRole('link', { name: 'MMR-3' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'MMR-4' })).toBeNull();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('renders no "on" line without links', async () => {
    await renderInRouter(<ArtifactList items={[artifact({ id: 'MMR-a1' })]} />);
    expect(screen.queryByText(/^on\b/)).toBeNull();
  });

  it('says so when nothing matches', async () => {
    await renderInRouter(<ArtifactList items={[]} />);
    expect(screen.getByText('No artifacts match.')).toBeInTheDocument();
  });
});
