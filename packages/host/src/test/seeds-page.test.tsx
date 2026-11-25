import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineSeed } from '../api/browse-queries';
import { seeds } from '../api/fns/browse';
import { SeedCaptureProvider } from '../components/seed-capture';
import { seedsRoute } from '../router';
import { seedIn } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { serveBareRecords } from './node-fns';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

// The project gate and the task pages these cases open read the record by server function.
beforeEach(() => {
  serveViews();
  serveBareRecords();
});
vi.mock('../components/patterns/notice', () => ({
  NoticeHost: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

/** One seed in every lane, two of them settled. */
const list: EngineSeed[] = [
  seedIn('untriaged', {
    id: 'MMR-s1',
    kind: 'bug',
    lede: 'The list scroll position jumps back to the top on every refetch.',
    title: 'Scroll snaps to top',
  }),
  seedIn('ready', {
    id: 'MMR-s2',
    kind: 'feature',
    requester: 'NRN',
    spawned: ['MMR-118'],
    title: 'Offline banner flicker',
  }),
  seedIn('promoted', { id: 'MMR-s3', spawned: ['MMR-90'], title: 'Promoted idea' }),
  seedIn('parked', { id: 'MMR-s6', title: 'Someday idea' }),
  seedIn('settled', { id: 'MMR-s4', title: 'Old resolved thing' }),
  seedIn('settled', { id: 'MMR-s5', lifecycle: 'rejected', title: 'Old rejected thing' }),
];

function mockApi(items: EngineSeed[] = list) {
  serveShell({
    projects: [
      engineProject({ id: 'MMR', title: 'Mimir' }),
      engineProject({ id: 'NRN', status: 'ready', title: 'Norn' }),
    ],
  });
  serveBrowse();
  // Every board answers the same queue, so a case can read any path's project.
  vi.mocked(seeds).mockResolvedValue(items);
}

const quietClient = () =>
  new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } });

const renderSeeds = (initial = '/p/MMR/seeds') =>
  renderRoute([seedsRoute], initial, quietClient(), SeedCaptureProvider);

const line = () => document.querySelector('[data-slot="list-count"]')?.textContent ?? '';

/** The count line's words, once the read has landed. */
async function countText() {
  await waitFor(() => {
    expect(line()).not.toBe('');
  });
  return line();
}
const groupHeadings = () =>
  screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');
const filterChip = () => screen.getByRole('button', { name: /^Filter/ });
const search = (r: Awaited<ReturnType<typeof renderSeeds>>['router']) => r.state.location.search;

afterEach(() => {
  vi.clearAllMocks();
});

describe('seedsPage (the Seeds list, MMR-725)', () => {
  it('heads the live lanes in order, folds Parked and Settled after them, and counts the open seeds', async () => {
    mockApi();
    await renderSeeds();
    await screen.findByText('Scroll snaps to top');
    expect(groupHeadings()).toStrictEqual(['To triage 1', 'Ready to resolve 1', 'Promoted 1']);
    await expect(countText()).resolves.toBe(
      '4 open seeds: 1 to triage, 1 ready to resolve, 1 promoted, 1 parked',
    );
    const parked = screen.getByRole('button', { name: 'Parked 1' });
    const settled = screen.getByRole('button', { name: 'Settled 2' });
    for (const fold of [parked, settled]) {
      expect(fold).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByText('Someday idea')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Promoted 1' }).compareDocumentPosition(parked) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('opens a folded lane in place to show its seeds', async () => {
    mockApi();
    const user = userEvent.setup();
    await renderSeeds();
    await user.click(await screen.findByRole('button', { name: 'Settled 2' }));
    expect(screen.getByRole('button', { name: 'Settled 2' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // A settled seed's card says how it settled.
    expect(cardOf(screen.getByRole('button', { name: 'Old rejected thing' }))).toHaveTextContent(
      'Rejected',
    );
    await user.click(screen.getByRole('button', { name: 'Parked 1' }));
    expect(screen.getByRole('button', { name: 'Someday idea' })).toBeVisible();
  });

  it('states each card’s kind, ID, origin, and age, and where its spawned work stands', async () => {
    mockApi();
    await renderSeeds();
    const ready = cardOf(await screen.findByRole('button', { name: 'Offline banner flicker' }));
    expect(within(ready).getByText('feature')).toBeVisible();
    expect(within(ready).getByText('MMR-s2')).toBeVisible();
    expect(within(ready).getByText(/from/)).toHaveTextContent('from NRN');
    expect(within(ready).getByText(/is done$/)).toHaveTextContent('MMR-118 is done');
    const promoted = cardOf(screen.getByRole('button', { name: 'Promoted idea' }));
    expect(within(promoted).getByText(/^Became/)).toHaveTextContent('Became MMR-90');
    // A seed filed in its own project names no origin.
    expect(screen.getAllByText(/^from\b/)).toHaveLength(1);
    // No card carries a button of its own.
    expect(document.querySelector('[data-slot="feed-card-action"]')).toBeNull();
  });

  it('opens a card’s preview with the lede and the seed’s page', async () => {
    mockApi();
    const user = userEvent.setup();
    const { router } = await renderSeeds();
    await user.click(await screen.findByRole('button', { name: 'Scroll snaps to top' }));
    const preview = await screen.findByRole('dialog', { name: 'Scroll snaps to top' });
    expect(
      within(preview).getByText('The list scroll position jumps back to the top on every refetch.'),
    ).toBeVisible();
    await user.click(within(preview).getByRole('link', { name: 'Open MMR-s1' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/p/MMR/s1');
    });
  });

  it.each([
    ['to-triage', 'To triage', 'Scroll snaps to top', '1 seed to triage'],
    ['ready-to-resolve', 'Ready to resolve', 'Offline banner flicker', '1 seed ready to resolve'],
    ['parked', 'Parked', 'Someday idea', '1 parked seed'],
    ['settled', 'Settled', 'Old resolved thing', '2 settled seeds'],
  ])(
    '?show=%s lists that lane alone under its chip, with no group head',
    async (show, label, title, count) => {
      mockApi();
      const user = userEvent.setup();
      const { router } = await renderSeeds(`/p/MMR/seeds?show=${show}`);
      await screen.findByRole('button', { name: title });
      await expect(countText()).resolves.toBe(count);
      expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
      // Promoted seeds show only under All.
      expect(screen.queryByRole('button', { name: 'Promoted idea' })).toBeNull();

      await user.click(screen.getByRole('button', { name: `Remove ${label}` }));
      await waitFor(() => {
        expect(search(router).show).toBeUndefined();
      });
      await screen.findByRole('heading', { name: 'Promoted 1' });
      expect(screen.getByRole('searchbox', { name: 'Search seeds' })).toHaveFocus();
    },
  );

  it('sets Show and Kind in the Filter sheet, counting what it will show, and applies only on its button', async () => {
    mockApi();
    const user = userEvent.setup();
    const { router } = await renderSeeds();
    await screen.findByText('Scroll snaps to top');
    await user.click(filterChip());
    const sheet = await screen.findByRole('dialog', { name: 'Filter seeds' });
    const show = within(sheet).getByRole('radiogroup', { name: 'Show' });
    expect(within(show).getByRole('radio', { name: 'All' })).toBeChecked();
    expect(within(sheet).getByRole('button', { name: 'Show 4 seeds' })).toBeEnabled();

    await user.click(within(show).getByRole('radio', { name: 'To resolve' }));
    await user.click(within(sheet).getByRole('checkbox', { name: 'Bug' }));
    expect(within(sheet).getByRole('button', { name: 'Show 0 seeds' })).toBeEnabled();
    await user.click(within(sheet).getByRole('checkbox', { name: 'Feature' }));
    expect(search(router).show).toBeUndefined();

    await user.click(within(sheet).getByRole('button', { name: 'Show 1 seed' }));
    await waitFor(() => {
      expect(search(router)).toEqual({ kind: 'bug,feature', show: 'ready-to-resolve' });
    });
    expect(screen.getByRole('button', { name: 'Remove Ready to resolve' })).toBeVisible();
    expect(filterChip()).toHaveAccessibleName('Filter, 1 applied');
    expect(filterChip()).toHaveFocus();

    // Opening again starts from what applies; Clear resets without applying.
    await user.click(filterChip());
    const again = await screen.findByRole('dialog', { name: 'Filter seeds' });
    expect(within(again).getByRole('radio', { name: 'To resolve' })).toBeChecked();
    expect(within(again).getByRole('checkbox', { name: 'Feature' })).toBeChecked();
    await user.click(within(again).getByRole('button', { name: 'Clear' }));
    expect(within(again).getByRole('radio', { name: 'All' })).toBeChecked();
    expect(within(again).getByRole('checkbox', { name: 'Feature' })).not.toBeChecked();
    expect(search(router)).toEqual({ kind: 'bug,feature', show: 'ready-to-resolve' });
  });

  it('offers "Show seeds" without a count while the seeds have not loaded', async () => {
    mockApi();
    vi.mocked(seeds).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    await renderSeeds();
    await user.click(filterChip());
    const sheet = await screen.findByRole('dialog', { name: 'Filter seeds' });
    expect(within(sheet).getByRole('button', { name: 'Show seeds' })).toBeEnabled();
  });

  it('narrows by a comma list of kinds from the URL, dropping words that name no kind', async () => {
    mockApi();
    const { router } = await renderSeeds('/p/MMR/seeds?kind=feature,epic');
    await screen.findByText('Offline banner flicker');
    expect(screen.queryByText('Scroll snaps to top')).toBeNull();
    expect(search(router)).toEqual({ kind: 'feature' });

    await act(async () => {
      await router.navigate({ href: '/p/MMR/seeds?kind=epic' });
    });
    await screen.findByText('Scroll snaps to top');
    expect(search(router)).not.toHaveProperty('kind');
  });

  it('searches titles and IDs, carrying the text into q', async () => {
    mockApi();
    const user = userEvent.setup();
    const { router } = await renderSeeds();
    const box = await screen.findByRole('searchbox', { name: 'Search seeds' });
    expect(box).toHaveAttribute('placeholder', 'Search titles and IDs');
    await user.type(box, 'mmr-s1');
    expect(screen.getByText('Scroll snaps to top')).toBeVisible();
    expect(screen.queryByText('Offline banner flicker')).toBeNull();
    await waitFor(() => {
      expect(search(router)).toMatchObject({ q: 'mmr-s1' });
    });
  });

  it('treats a numeric q in the URL as text', async () => {
    mockApi([
      seedIn('untriaged', { id: 'MMR-s1', title: 'Scroll snaps to top' }),
      seedIn('untriaged', { id: 'MMR-s2', title: 'Retry 45 times' }),
    ]);
    await renderSeeds('/p/MMR/seeds?q=45');
    await screen.findByText('Retry 45 times');
    expect(screen.queryByText('Scroll snaps to top')).toBeNull();
  });

  it('says "No seeds match." when the filters exclude everything', async () => {
    mockApi();
    const user = userEvent.setup();
    await renderSeeds();
    await user.type(await screen.findByRole('searchbox', { name: 'Search seeds' }), 'zzzzz');
    await expect(screen.findByText('No seeds match.')).resolves.toBeVisible();
  });

  it('says so when a lane is empty', async () => {
    mockApi([seedIn('promoted', { id: 'MMR-s3' })]);
    await renderSeeds('/p/MMR/seeds?show=to-triage');
    await expect(
      screen.findByText('Nothing to triage. Every seed has a lane.'),
    ).resolves.toBeVisible();
    await expect(countText()).resolves.toBe('No seeds to triage');
  });

  it('files a seed from the count line, and offers it when the project has none yet', async () => {
    mockApi([]);
    const user = userEvent.setup();
    await renderSeeds();
    await expect(screen.findByText('No seeds yet.')).resolves.toBeVisible();
    await expect(countText()).resolves.toBe('No seeds');
    await user.click(screen.getByRole('button', { name: 'File a seed' }));
    await expect(screen.findByLabelText('Seed')).resolves.toBeDefined();
  });

  it('scopes the read to the project in the path', async () => {
    mockApi();
    await renderSeeds('/p/NRN/seeds');
    await screen.findByText('Scroll snaps to top');
    expect(seeds).toHaveBeenCalledWith({ data: { project: 'NRN', status: 'all' } });
  });
});

/** A seed's card, found from its target button. */
function cardOf(target: HTMLElement): HTMLElement {
  const card = target.closest<HTMLElement>('[data-slot="feed-card"]');
  if (card === null) {
    throw new Error('no card');
  }
  return card;
}
