import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { ArtifactSummary } from '../api/browse-queries';
import { artifacts } from '../api/fns/browse';
import { artifactsRoute } from '../router';
import { engineArtifact } from './browse-fixtures';
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

/** 09:00 on Wednesday 25 November 2026 in New York, the suite's zone. */
const NOW = Date.parse('2026-11-25T14:00:00.000Z');

// The project gate reads the record by server function.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  serveViews();
  serveBareRecords();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** An artifact frozen `hoursAgo` hours before NOW. */
const frozen = (n: number, hoursAgo: number, over: Partial<ArtifactSummary> = {}) =>
  engineArtifact({
    createdAt: new Date(NOW - hoursAgo * 3_600_000),
    id: `MMR-a${String(n)}`,
    title: `Artifact ${String(n)}`,
    ...over,
  });

/** `count` artifacts, newest first, an hour apart, all frozen today. */
const many = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    frozen(i + 1, i / 60, { title: `Artifact ${String(i + 1)}` }),
  );

/** Serve the given artifact rows and one project, MMR. */
function serveRows(items: ArtifactSummary[]) {
  serveShell({ projects: [engineProject({ id: 'MMR' })] });
  return serveBrowse({ artifacts: items });
}

const renderArtifacts = (initial = '/p/MMR/artifacts') =>
  renderRoute(
    [artifactsRoute],
    initial,
    new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } }),
  );

/** The artifact-list reads issued so far, as the `artifacts` inputs they sent. */
const reads = () => vi.mocked(artifacts).mock.calls.map(([{ data }]) => data);
/** The list reads, leaving out the Filter sheet's counts (`limit: 0`). */
const listReads = () => reads().filter((data) => data.limit !== 0);

const countText = () => document.querySelector('[data-slot="list-count"]')?.textContent;
const showMore = () => screen.queryByRole('button', { name: /^Show \d+ more artifacts$/ });
const filterChip = () => screen.getByRole('button', { name: /^Filter/ });

describe('artifactsPage (the Artifacts list, MMR-725)', () => {
  it('folds artifacts by the day they were frozen, newest first, with only the newest day open', async () => {
    serveRows([
      frozen(3, 0.5, {
        links: ['MMR-717', 'MMR-724'],
        tags: ['session_summary'],
        title: 'Session summary: the Tasks list',
      }),
      frozen(2, 20, {
        links: ['MMR-1', 'MMR-2', 'MMR-3', 'MMR-4', 'MMR-5'],
        tags: ['workspace_unconsolidated', 'spec'],
        title: 'The list spec',
      }),
      frozen(1, 21, { title: 'PR-LEDGER.md' }),
    ]);
    const user = userEvent.setup();
    await renderArtifacts();

    const today = await screen.findByRole('button', { name: 'Today 1' });
    expect(today).toHaveAttribute('aria-expanded', 'true');
    const yesterday = screen.getByRole('button', { name: 'Yesterday 2' });
    expect(yesterday).toHaveAttribute('aria-expanded', 'false');
    expect(countText()).toBe('3 artifacts');

    // The row: its title, then the kind as a word and the records it is on, the time at the right.
    const row = screen.getByRole('link', { name: /Session summary: the Tasks list/ });
    expect(row).toHaveAttribute('href', '/p/MMR/a3');
    expect(row).toHaveTextContent(/Session summary\s*On MMR-717, MMR-724/);
    expect(row).toHaveTextContent('08:30');

    await user.click(yesterday);
    const spec = screen.getByRole('link', { name: /The list spec/ });
    // Three records, then the rest as +N, so the meta keeps to one line.
    expect(spec).toHaveTextContent(/Spec\s*On MMR-1, MMR-2, MMR-3\s*\+2/);
    // A row with no kind and no records shows its title and time alone.
    expect(screen.getByRole('link', { name: /PR-LEDGER\.md/ })).toHaveTextContent(
      /^PR-LEDGER\.md\s*12:00$/,
    );
  });

  it('caps an open day at five rows, then Show N more reveals the rest', async () => {
    serveRows(many(7));
    const user = userEvent.setup();
    await renderArtifacts();
    const day = await screen.findByRole('button', { name: 'Today 7' });
    const panel = document.getElementById(day.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(within(panel).getAllByRole('link')).toHaveLength(5);

    await user.click(within(panel).getByRole('button', { name: 'Show 2 more' }));
    expect(within(panel).getAllByRole('link')).toHaveLength(7);
  });

  it('reads the first window, and Show N more asks for the next while the count line says how many show', async () => {
    serveRows(many(120));
    const user = userEvent.setup();
    await renderArtifacts();
    await screen.findByRole('button', { name: /^Today/ });
    expect(listReads()).toStrictEqual([{ limit: 50, project: 'MMR' }]);
    expect(countText()).toBe('50 of 120 artifacts');

    await user.click(showMore() as HTMLElement);
    await waitFor(() => {
      expect(countText()).toBe('100 of 120 artifacts');
    });
    expect(listReads().at(-1)).toStrictEqual({ limit: 100, project: 'MMR' });
    expect(showMore()).toHaveTextContent('Show 20 more');

    await user.click(showMore() as HTMLElement);
    await waitFor(() => {
      expect(countText()).toBe('120 artifacts');
    });
    expect(showMore()).toBeNull();
  });

  it('keeps the shown rows and says so when a larger window fails, and Show N more retries it', async () => {
    serveRows(many(60));
    let fail = true;
    const served = vi.mocked(artifacts).getMockImplementation();
    vi.mocked(artifacts).mockImplementation(async (input) => {
      if (input.data.limit === 100 && fail) {
        throw new Error('down');
      }
      return served === undefined ? Promise.reject(new Error('unserved')) : served(input);
    });
    const user = userEvent.setup();
    await renderArtifacts();
    await screen.findByRole('button', { name: /^Today/ });

    await user.click(showMore() as HTMLElement);
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent(
      "Couldn't load more artifacts.",
    );
    expect(countText()).toBe('50 of 60 artifacts');
    expect(screen.getByRole('button', { name: /^Today/ })).toBeVisible();

    fail = false;
    await user.click(showMore() as HTMLElement);
    await waitFor(() => {
      expect(countText()).toBe('60 artifacts');
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('picks one kind in the Filter sheet, names what it will show, and applies it as the tag', async () => {
    serveRows([frozen(2, 1, { tags: ['spec'] }), frozen(1, 2, { tags: ['session_summary'] })]);
    const user = userEvent.setup();
    const { router } = await renderArtifacts();
    await screen.findByRole('button', { name: /^Today/ });

    await user.click(filterChip());
    const sheet = await screen.findByRole('dialog', { name: 'Filter artifacts' });
    const kinds = within(sheet).getByRole('radiogroup', { name: 'Kind' });
    expect(within(kinds).getByRole('radio', { name: 'Any kind' })).toBeChecked();
    await expect(
      within(sheet).findByRole('button', { name: 'Show 2 artifacts' }),
    ).resolves.toBeEnabled();

    await user.click(within(kinds).getByRole('radio', { name: 'Spec' }));
    const commit = await within(sheet).findByRole('button', { name: 'Show 1 artifact' });
    // Nothing applies before the commit.
    expect(router.state.location.search).toEqual({});
    await user.click(commit);
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tag: 'spec' });
    });
    expect(listReads().at(-1)).toStrictEqual({ limit: 50, project: 'MMR', tag: 'spec' });
    expect(filterChip()).toHaveAccessibleName('Filter, 1 applied');
    await waitFor(() => {
      expect(countText()).toBe('1 artifact');
    });

    // The sheet opens on the kind that applies; Clear goes back to any kind without applying.
    await user.click(filterChip());
    const again = await screen.findByRole('dialog', { name: 'Filter artifacts' });
    expect(within(again).getByRole('radio', { name: 'Spec' })).toBeChecked();
    await user.click(within(again).getByRole('button', { name: 'Clear' }));
    expect(within(again).getByRole('radio', { name: 'Any kind' })).toBeChecked();
    expect(router.state.location.search).toEqual({ tag: 'spec' });
  });

  it('does not show the old filter’s rows while a new filter loads', async () => {
    serveRows([frozen(2, 1, { tags: ['spec'] }), frozen(1, 2, { tags: ['session_summary'] })]);
    const served = vi.mocked(artifacts).getMockImplementation();
    vi.mocked(artifacts).mockImplementation(async (input) => {
      if (input.data.tag === 'spec' && input.data.limit !== 0) {
        return new Promise(() => {});
      }
      return served === undefined ? Promise.reject(new Error('unserved')) : served(input);
    });
    const user = userEvent.setup();
    await renderArtifacts();
    await screen.findByText('Artifact 1');

    await user.click(filterChip());
    const sheet = await screen.findByRole('dialog', { name: 'Filter artifacts' });
    await user.click(within(sheet).getByRole('radio', { name: 'Spec' }));
    await user.click(await within(sheet).findByRole('button', { name: 'Show 1 artifact' }));
    await waitFor(() => {
      expect(listReads().at(-1)).toStrictEqual({ limit: 50, project: 'MMR', tag: 'spec' });
    });
    expect(screen.queryByText('Artifact 1')).toBeNull();
    expect(screen.queryByText('Artifact 2')).toBeNull();
  });

  it('keeps a plain tag and the dates a link carries as removable chips after Filter', async () => {
    serveRows([frozen(1, 1, { tags: ['workspace_unconsolidated'] })]);
    const user = userEvent.setup();
    const { router } = await renderArtifacts(
      '/p/MMR/artifacts?tag=workspace_unconsolidated&atOrAfter=2026-11-20&atOrBefore=2026-11-24',
    );
    await screen.findByRole('button', { name: /^Today/ });

    const chips = document.querySelector('[data-slot="list-chips"]') as HTMLElement;
    expect(
      within(chips)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toStrictEqual([
      'Filter',
      'Remove Tagged workspace_unconsolidated',
      'Remove Since 20 November',
      'Remove Until 24 November',
    ]);
    expect(listReads().at(-1)).toMatchObject({
      dates: [
        { field: 'created_at', op: 'at-or-after', value: '2026-11-20' },
        { field: 'created_at', op: 'at-or-before', value: '2026-11-24' },
      ],
      tag: 'workspace_unconsolidated',
    });

    await user.click(
      screen.getByRole('button', { name: 'Remove Tagged workspace_unconsolidated' }),
    );
    await waitFor(() => {
      expect(router.state.location.search).toEqual({
        atOrAfter: '2026-11-20',
        atOrBefore: '2026-11-24',
      });
    });
    expect(screen.getByRole('searchbox', { name: 'Search artifacts' })).toHaveFocus();
  });

  it('says so when a filter matches nothing, and when the project has no artifacts', async () => {
    serveRows([frozen(1, 1, { tags: ['spec'] })]);
    await renderArtifacts('/p/MMR/artifacts?tag=plan');
    await expect(screen.findByText('No artifacts match.')).resolves.toBeVisible();
    expect(countText()).toBe('No artifacts');
  });

  it('says the project has none yet when nothing is frozen to it', async () => {
    serveRows([]);
    await renderArtifacts();
    await expect(screen.findByText('No artifacts yet.')).resolves.toBeVisible();
  });

  it('scopes the read to the project in the path and keeps a numeric q as text', async () => {
    serveRows([frozen(1, 1)]);
    await renderArtifacts('/p/MMR/artifacts?q=2026');
    await screen.findByRole('button', { name: /^Today/ });
    expect(listReads().at(-1)).toStrictEqual({ limit: 50, project: 'MMR', q: '2026' });
    expect(screen.getByRole('searchbox', { name: 'Search artifacts' })).toHaveValue('2026');
  });
});
