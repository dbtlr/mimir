import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import type { WireArtifactDetail } from '../api/types';
import { ArtifactReader } from '../components/artifact-reader';
import { renderInRouter } from './router';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

const detail: WireArtifactDetail = {
  content: '# Heading\n\nbody with `inline code`\n',
  // Midday UTC so the local calendar date is stable across test timezones.
  created_at: '2026-06-16T12:00:00.000Z',
  id: 'MMR-a8',
  links: [{ id: 'MMR-52', status: 'done', title: 'Doctor read-surface' }],
  project: 'MMR',
  tags: ['kind:session', 'doctor'],
  title: 'Artifacts browser',
};

function mockApi(overrides: Partial<WireArtifactDetail> = {}) {
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/projects')) {
      return Promise.resolve({
        items: [{ id: 'MMR', status: 'ready', title: 'Mimir' }],
        total: 1,
      });
    }
    if (path.startsWith('/api/artifacts/')) {
      return Promise.resolve({ ...detail, ...overrides });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

describe('artifactReader', () => {
  it('renders the body, the frozen/immutable microlabel, and the provenance rail', async () => {
    mockApi();
    await renderInRouter(<ArtifactReader id="MMR-a8" onBack={vi.fn()} />);
    await expect(screen.findByRole('heading', { name: 'Heading' })).resolves.toBeDefined();
    expect(screen.getByText('Artifacts browser')).toBeDefined();
    // The freeze cue is text (screen-reader legible), standing where edit would be.
    expect(screen.getByText(/FROZEN 2026-06-16 · IMMUTABLE/)).toBeDefined();
    // Rail: linked node with status dot + id + title; project; kind/tags split.
    // The dot is aria-hidden color, so the accessible name carries the status.
    const rail = await screen.findByRole('complementary', { name: /provenance/i });
    expect(within(rail).getByText('Linked nodes')).toBeDefined();
    expect(
      within(rail).getByRole('link', { name: 'Open MMR-52 Doctor read-surface — Done' }),
    ).toBeDefined();
    expect(within(rail).getByText('Kind · tags')).toBeDefined();
    expect(within(rail).getByText('session')).toBeDefined();
    expect(within(rail).getByText('doctor')).toBeDefined();
  });

  it('back returns to the browser, and the id opens the artifact page (MMR-452)', async () => {
    mockApi();
    const onBack = vi.fn();
    await renderInRouter(<ArtifactReader id="MMR-a8" onBack={onBack} />);
    await screen.findByText('Artifacts browser');
    await userEvent.click(screen.getByRole('button', { name: '← Artifacts' }));
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'MMR-a8' })).toHaveAttribute('href', '/p/MMR/a8');
  });

  it('links no page until the artifact has loaded, so a stray id never points elsewhere', async () => {
    apiGet.mockRejectedValue(new Error('unreachable'));
    await renderInRouter(<ArtifactReader id="MMR-419" onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'MMR-419' });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it("a rail link goes to its node's page; the project row to the project's page", async () => {
    mockApi();
    await renderInRouter(<ArtifactReader id="MMR-a8" onBack={vi.fn()} />);
    const rail = await screen.findByRole('complementary', { name: /provenance/i });
    await expect(
      within(rail).findByRole('link', { name: 'Open MMR-52 Doctor read-surface — Done' }),
    ).resolves.toHaveAttribute('href', '/p/MMR/52');
    expect(within(rail).getByRole('link', { name: 'Open project MMR' })).toHaveAttribute(
      'href',
      '/p/MMR',
    );
  });

  it('mobile chip row: the owning project is the first chip', async () => {
    mockApi();
    await renderInRouter(<ArtifactReader id="MMR-a8" onBack={vi.fn()} />);
    await screen.findByText('Artifacts browser');
    const chips = within(screen.getByTestId('provenance-chips')).getAllByRole('link');
    expect(chips[0]).toHaveAccessibleName('Open project MMR');
    expect(chips[1]).toHaveAccessibleName('Open MMR-52 Doctor read-surface — Done');
  });

  it('mobile chip row keeps the project chip with zero linked nodes (never a dead end)', async () => {
    mockApi({ links: [] });
    await renderInRouter(<ArtifactReader id="MMR-a8" onBack={vi.fn()} />);
    await screen.findByText('Artifacts browser');
    const chips = within(screen.getByTestId('provenance-chips')).getAllByRole('link');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveAccessibleName('Open project MMR');
    // …and the rail omits the empty LINKED NODES block.
    expect(screen.queryByText('Linked nodes')).toBeNull();
  });

  it('mounts no h1: the title is an h2 under the page heading, body headings demote below it', async () => {
    mockApi();
    await renderInRouter(<ArtifactReader id="MMR-a8" onBack={vi.fn()} />);
    // The artifact title is h2 (the page's h1 lives in the master pane) …
    await expect(
      screen.findByRole('heading', { level: 2, name: 'Artifacts browser' }),
    ).resolves.toBeDefined();
    // … the body's markdown `# Heading` demotes to h3, below the title …
    expect(screen.getByRole('heading', { level: 3, name: 'Heading' })).toBeDefined();
    // … and the reader never contributes a second level-1 heading.
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('a dangling link degrades to its bare mono id', async () => {
    mockApi({ links: [{ id: 'MMR-99' }] });
    await renderInRouter(<ArtifactReader id="MMR-a8" onBack={vi.fn()} />);
    const rail = await screen.findByRole('complementary', { name: /provenance/i });
    await expect(within(rail).findByRole('link', { name: 'Open MMR-99' })).resolves.toBeDefined();
  });
});
