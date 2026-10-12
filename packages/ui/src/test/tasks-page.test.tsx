import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import { FINISHED_PAGE_SIZE } from '../api/queries';
import type { WireHome, WireNode } from '../api/types';
import { router } from '../router';
import { task } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

/** A home facet under project MMR; `open` marks the parent as a standing home. */
function home(parentTitle: string, open = false): WireHome {
  return {
    parent_id: 'MMR-1',
    parent_open_ended: open ? true : null,
    parent_title: parentTitle,
    project_key: 'MMR',
  };
}

/** Five tasks across two projects, deliberately NOT in activity order. */
const rows: WireNode[] = [
  task({
    home: home('Wire hardening'),
    id: 'MMR-10',
    lede: 'Make the wire honest.',
    status: 'ready',
    title: 'Doctor the wire',
    updated_at: '2026-06-11T10:00:00.000Z',
  }),
  task({
    home: home('Storage cutover', true),
    id: 'MMR-12',
    status: 'done',
    summary: 'The schema landed.',
    title: 'Land the schema',
    updated_at: '2026-06-10T12:00:00.000Z',
  }),
  task({
    home: home('Storage cutover', true),
    id: 'MMR-11',
    lede: 'The lede wins.',
    status: 'under_review',
    summary: 'The summary loses.',
    title: 'Review the cutover',
    updated_at: '2026-06-11T11:00:00.000Z',
  }),
  task({
    home: home('Wire hardening'),
    id: 'MMR-13',
    status: 'abandoned',
    title: 'Old dead end',
    updated_at: '2026-06-05T12:00:00.000Z',
  }),
  task({
    home: { ...home('Layer 4'), project_key: 'NRN' },
    id: 'NRN-4',
    status: 'ready',
    title: 'Hoist the lookup',
    updated_at: '2026-06-11T12:00:00.000Z',
  }),
];

function mockApi() {
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/projects')) {
      return Promise.resolve({
        items: [
          { id: 'MMR', status: 'in_progress', title: 'Mimir' },
          { id: 'NRN', status: 'ready', title: 'Norn' },
        ],
        total: 2,
      });
    }
    if (path.startsWith('/api/nodes?')) {
      return Promise.resolve({ items: rows, total: rows.length });
    }
    if (path.includes('/annotations')) {
      return Promise.resolve({ items: [], total: 0 });
    }
    if (path.startsWith('/api/nodes/')) {
      // the task page's detail fetch after a row click
      return Promise.resolve(rows[0]);
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function renderTasks(initial = '/tasks') {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } })
      }
    >
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

const search = (r: ReturnType<typeof renderTasks>) =>
  r.state.location.search as { project?: string; status?: string; q?: string; group?: string };

/** The `/api/nodes?` list reads issued so far, as query-string objects. */
const nodeReads = () =>
  apiGet.mock.calls
    .map((c) => c[0] as string)
    .filter((p) => p.startsWith('/api/nodes?'))
    .map((p) => new URLSearchParams(p.slice('/api/nodes?'.length)));

/** The group headings on the page, in order (e.g. `Ready · 2`). */
const groupHeadings = () =>
  screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');

/** The titles inside one group, top to bottom. */
const titlesIn = (heading: string) =>
  within(screen.getByRole('region', { name: heading }))
    .getAllByRole('link')
    .map((l) => l.textContent);

const live = () => screen.getByRole('button', { name: 'Live' });
const finished = () => screen.getByRole('button', { name: 'Finished' });

/** A task row's container, found from its title link. */
const rowOf = (title: string) => {
  const row = screen.getByRole('link', { name: title }).closest('.relative');
  if (row === null) {
    throw new Error(`no row for ${title}`);
  }
  return row as HTMLElement;
};

describe('tasksPage (grouped reading list, MMR-454)', () => {
  it('groups by status in the stated order with counts, hiding empty groups', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Doctor the wire');
    expect(groupHeadings()).toStrictEqual([
      'Under review · 1',
      'Ready · 2',
      'Done · 1',
      'Abandoned · 1',
    ]);
    // newest activity first inside a group
    expect(titlesIn('Ready · 2')).toStrictEqual(['Hoist the lookup', 'Doctor the wire']);
  });

  it('the header names the live count and reads the portfolio task selection with the lede', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Doctor the wire');
    expect(screen.getByText('5 live')).toBeDefined();
    const read = nodeReads().find((p) => p.get('col') === 'lede');
    expect(read?.get('type')).toBe('task');
    expect(read?.get('col')).toBe('lede');
  });

  it('group=project groups by project key, alphabetically, newest first', async () => {
    mockApi();
    renderTasks('/tasks?group=project');
    await screen.findByText('Doctor the wire');
    expect(groupHeadings()).toStrictEqual(['MMR · 4', 'NRN · 1']);
    expect(titlesIn('MMR · 4')).toStrictEqual([
      'Review the cutover',
      'Doctor the wire',
      'Land the schema',
      'Old dead end',
    ]);
  });

  it('the group menu switches the grouping and keeps it in the URL', async () => {
    mockApi();
    const testRouter = renderTasks();
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    await user.click(screen.getByRole('button', { name: /Group: status/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Project' }));
    await waitFor(() => {
      expect(search(testRouter).group).toBe('project');
    });
    expect(groupHeadings()).toStrictEqual(['MMR · 4', 'NRN · 1']);

    await user.click(screen.getByRole('button', { name: /Group: project/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Status' }));
    await waitFor(() => {
      expect(search(testRouter).group).toBeUndefined();
    });
  });

  it('drops an invalid group value', async () => {
    mockApi();
    renderTasks('/tasks?group=nonsense');
    await screen.findByText('Doctor the wire');
    expect(screen.getByRole('button', { name: /Group: status/ })).toBeDefined();
    expect(groupHeadings()[0]).toBe('Under review · 1');
  });

  it('every row is a link to the task page', async () => {
    mockApi();
    const testRouter = renderTasks();
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    const link = screen.getByRole('link', { name: 'Doctor the wire' });
    expect(link).toHaveAttribute('href', '/p/MMR/10');
    expect(screen.getByRole('link', { name: 'Hoist the lookup' })).toHaveAttribute(
      'href',
      '/p/NRN/4',
    );
    await user.click(link);
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR/10');
    });
  });

  it('shows the lede, preferring it over the summary', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Doctor the wire');
    expect(within(rowOf('Review the cutover')).getByText('The lede wins.')).toBeDefined();
    expect(screen.queryByText('The summary loses.')).toBeNull();
    // no lede on the wire falls back to the summary
    expect(within(rowOf('Land the schema')).getByText('The schema landed.')).toBeDefined();
  });

  it('the meta line reads key › parent, with ∞ on a standing home, then the age', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Doctor the wire');
    const review = rowOf('Review the cutover');
    expect(within(review).getByText('MMR').className).toContain('font-mono');
    expect(review.textContent).toContain('› Storage cutover');
    expect(review.textContent).toContain(' · ');
    expect(
      within(review).getByRole('img', { name: 'open-ended — a standing home' }).textContent,
    ).toContain('∞');
    expect(within(rowOf('Doctor the wire')).queryByRole('img')).toBeNull();
  });

  it('demotes finished rows by ink tier, never opacity', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Doctor the wire');
    expect(screen.getByRole('link', { name: 'Land the schema' }).className).toContain(
      'text-ink-dim',
    );
    expect(rowOf('Land the schema').className).not.toContain('opacity');
    expect(screen.getByRole('link', { name: 'Doctor the wire' }).className).toContain(
      'text-ink-bright',
    );
  });

  it('strikes through abandoned titles only', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Old dead end');
    expect(screen.getByRole('link', { name: 'Old dead end' }).className).toContain('line-through');
    expect(screen.getByRole('link', { name: 'Land the schema' }).className).not.toContain(
      'line-through',
    );
  });

  it('Live is pressed by default; Finished sets status=terminal in the URL and the request', async () => {
    mockApi();
    const testRouter = renderTasks();
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    expect(live().getAttribute('aria-pressed')).toBe('true');
    expect(finished().getAttribute('aria-pressed')).toBe('false');

    await user.click(finished());
    await waitFor(() => {
      expect(search(testRouter).status).toBe('terminal');
    });
    await waitFor(() => {
      expect(nodeReads().some((p) => p.get('status') === 'terminal')).toBe(true);
    });
    expect(finished().getAttribute('aria-pressed')).toBe('true');
    expect(live().getAttribute('aria-pressed')).toBe('false');
    await expect(screen.findByText('5 finished')).resolves.toBeDefined();

    await user.click(live());
    await waitFor(() => {
      expect(search(testRouter).status).toBeUndefined();
    });
    expect(live().getAttribute('aria-pressed')).toBe('true');
  });

  it('a deep-linked status shows a removable chip, presses neither view, and removing returns to Live', async () => {
    mockApi();
    const testRouter = renderTasks('/tasks?status=ready');
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    expect(screen.getByRole('button', { name: 'Live' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Finished' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(nodeReads().some((p) => p.get('status') === 'ready')).toBe(true);
    expect(screen.getByText('5 match')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Remove status filter Ready' }));
    await waitFor(() => {
      expect(search(testRouter).status).toBeUndefined();
    });
    expect(screen.getByRole('button', { name: 'Live' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: /Remove status filter/ })).toBeNull();
  });

  it('treats an empty status in the URL as the Live view with no removable chip', async () => {
    mockApi();
    renderTasks('/tasks?status=');
    await screen.findByText('Doctor the wire');
    expect(live().getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: /Remove status filter/ })).toBeNull();
    expect(nodeReads().some((p) => p.get('status') === 'live')).toBe(true);
  });

  it('survives a numeric status in the URL', async () => {
    mockApi();
    renderTasks('/tasks?status=1');
    await screen.findByText('Doctor the wire');
    expect(screen.getByRole('heading', { level: 1, name: 'Tasks' })).toBeDefined();
  });

  it('removing the status chip hands keyboard focus to the search box', async () => {
    mockApi();
    renderTasks('/tasks?status=ready');
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');
    await user.click(screen.getByRole('button', { name: 'Remove status filter Ready' }));
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveFocus();
  });

  it('says each row status in text, not only by the dot colour', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Doctor the wire');
    expect(within(rowOf('Review the cutover')).getByText('Under review')).toBeInTheDocument();
    expect(within(rowOf('Doctor the wire')).getByText('Ready')).toBeInTheDocument();
  });

  it('labels a deep-linked union and the all selector', async () => {
    mockApi();
    renderTasks('/tasks?status=ready,blocked');
    await screen.findByText('Doctor the wire');
    expect(
      screen.getByRole('button', { name: 'Remove status filter Ready, Blocked' }),
    ).toBeDefined();
  });

  it('restores a deep-linked project and search, and the project menu sets project', async () => {
    mockApi();
    const testRouter = renderTasks('/tasks?project=MMR&q=cutover');
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'cutover');
    const read = nodeReads().find((p) => p.get('q') === 'cutover');
    expect(read?.get('project')).toBe('MMR');

    await user.click(screen.getByRole('button', { name: /^MMR/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'All projects' }));
    await waitFor(() => {
      expect(search(testRouter).project).toBeUndefined();
    });
    await user.click(screen.getByRole('button', { name: /All projects/ }));
    await user.click(await screen.findByRole('menuitem', { name: /NRN/ }));
    await waitFor(() => {
      expect(search(testRouter).project).toBe('NRN');
    });
  });

  it('typing in the search box updates q after the debounce', async () => {
    mockApi();
    const testRouter = renderTasks();
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    const box = screen.getByRole('searchbox', { name: 'Search tasks' });
    expect(box).toHaveAttribute('placeholder', 'Search titles and IDs…');
    await user.type(box, 'wire');
    await waitFor(() => {
      expect(search(testRouter).q).toBe('wire');
    });
    await waitFor(() => {
      expect(nodeReads().some((p) => p.get('q') === 'wire')).toBe(true);
    });
  });

  it('says so when nothing matches', async () => {
    apiGet.mockImplementation((path: string) =>
      path.startsWith('/api/projects')
        ? Promise.resolve({ items: [], total: 0 })
        : Promise.resolve({ items: [], total: 0 }),
    );
    renderTasks();
    await expect(screen.findByText('No tasks match.')).resolves.toBeDefined();
  });

  it('unreachable with nothing cached keeps the honest error and disables + New task', async () => {
    apiGet.mockRejectedValue(new Error('down'));
    renderTasks();
    await expect(
      screen.findByText(/Unreachable — is `mimir serve` running\?/),
    ).resolves.toBeDefined();
    expect(screen.getByRole('button', { name: '+ New task' })).toHaveProperty('disabled', true);
  });
});

const rowCount = () => screen.queryAllByRole('link', { name: /^Finished \d+$/ }).length;
const showMore = () => screen.queryByRole('button', { name: 'Show more' });

/** The `limit` of every terminal list read so far, in request order. */
const terminalLimits = () =>
  nodeReads()
    .filter((p) => p.get('status') === 'terminal')
    .map((p) => p.get('limit'));

/** Finished tasks, newest completion first: hour by hour, so the order is unambiguous. */
const finishedTasks = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.UTC(2026, 5, 20, 23, 0, 0) - i * 3_600_000).toISOString();
    return task({
      completed_at: at,
      id: `MMR-${String(1000 + i)}`,
      status: 'done',
      title: `Finished ${String(i)}`,
      updated_at: at,
    });
  });

/**
 * Serves `/api/nodes` terminal reads honoring `limit` like the server (the
 * newest `limit` of `all`, whole `total`); other reads get `rows`. `gate`
 * lets a test hold or fail a read by its limit.
 */
function mockTerminalApi(
  all: WireNode[],
  gate: (limit: number) => Promise<void> | undefined = () => undefined,
) {
  apiGet.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/projects')) {
      return { items: [{ id: 'MMR', status: 'in_progress', title: 'Mimir' }], total: 1 };
    }
    if (path.startsWith('/api/nodes?')) {
      const p = new URLSearchParams(path.slice('/api/nodes?'.length));
      if (p.get('status') !== 'terminal') {
        return { items: rows, total: rows.length };
      }
      const limit = p.has('limit') ? Number(p.get('limit')) : all.length;
      await gate(limit);
      return { items: all.slice(0, limit), total: all.length };
    }
    throw new Error(`unexpected ${path}`);
  });
}

describe('tasksPage Finished view windows (MMR-460)', () => {
  // Two full windows and a partial third.
  const finishedCount = FINISHED_PAGE_SIZE * 2 + 10;

  it('asks for one bounded window first and offers Show more', async () => {
    mockTerminalApi(finishedTasks(finishedCount));
    renderTasks('/tasks?status=terminal');
    await screen.findByText('Finished 0');

    expect(rowCount()).toBe(FINISHED_PAGE_SIZE);
    expect(terminalLimits()).toStrictEqual([String(FINISHED_PAGE_SIZE)]);
    const first = nodeReads().find((p) => p.get('status') === 'terminal');
    expect(first?.has('offset')).toBe(false);
    expect(first?.get('col')).toBe('lede');
    expect(
      screen.getByText(`${String(FINISHED_PAGE_SIZE)} of ${String(finishedCount)} finished`),
    ).toBeDefined();
    expect(showMore()).not.toBeNull();
  });

  it('Show more asks for a larger limit, keeps the rows meanwhile, and goes once all are loaded', async () => {
    const held = Promise.withResolvers<void>();
    mockTerminalApi(finishedTasks(finishedCount), (limit) =>
      limit === FINISHED_PAGE_SIZE * 2 ? held.promise : undefined,
    );
    renderTasks('/tasks?status=terminal');
    const user = userEvent.setup();
    await screen.findByText('Finished 0');

    await user.click(showMore() as HTMLElement);
    // The larger read is in flight: the shown rows stay, the button is inert.
    await waitFor(() => {
      expect(terminalLimits()).toContain(String(FINISHED_PAGE_SIZE * 2));
    });
    expect(rowCount()).toBe(FINISHED_PAGE_SIZE);
    expect(showMore()).toBeDisabled();

    held.resolve();
    await waitFor(() => {
      expect(rowCount()).toBe(FINISHED_PAGE_SIZE * 2);
    });
    expect(showMore()).not.toBeDisabled();

    await user.click(showMore() as HTMLElement);
    await waitFor(() => {
      expect(rowCount()).toBe(finishedCount);
    });
    expect(terminalLimits()).toContain(String(FINISHED_PAGE_SIZE * 3));
    expect(showMore()).toBeNull();
    expect(screen.getByText(`${String(finishedCount)} finished`)).toBeDefined();
  });

  it('has no Show more when every finished task fits one window', async () => {
    mockTerminalApi(finishedTasks(3));
    renderTasks('/tasks?status=terminal');
    await screen.findByText('Finished 0');
    expect(showMore()).toBeNull();
  });

  it('keeps the shown rows, says so, and retries when the larger window fails', async () => {
    let fail = true;
    mockTerminalApi(finishedTasks(finishedCount), (limit) =>
      limit === FINISHED_PAGE_SIZE * 2 && fail ? Promise.reject(new Error('down')) : undefined,
    );
    renderTasks('/tasks?status=terminal');
    const user = userEvent.setup();
    await screen.findByText('Finished 0');

    await user.click(showMore() as HTMLElement);
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent(/more finished tasks/i);
    expect(rowCount()).toBe(FINISHED_PAGE_SIZE);
    expect(showMore()).not.toBeDisabled();

    fail = false;
    await user.click(showMore() as HTMLElement);
    await waitFor(() => {
      expect(rowCount()).toBe(FINISHED_PAGE_SIZE * 2);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('starts over at one window when the view changes', async () => {
    mockTerminalApi(finishedTasks(finishedCount));
    renderTasks('/tasks?status=terminal');
    const user = userEvent.setup();
    await screen.findByText('Finished 0');
    await user.click(showMore() as HTMLElement);
    await waitFor(() => {
      expect(rowCount()).toBe(FINISHED_PAGE_SIZE * 2);
    });

    await user.click(live());
    await screen.findByText('Doctor the wire');
    await user.click(finished());
    await waitFor(() => {
      expect(rowCount()).toBe(FINISHED_PAGE_SIZE);
    });
    expect(showMore()).not.toBeNull();
  });

  it('orders Finished rows by completion, not by last edit', async () => {
    const edited = task({
      completed_at: '2026-05-01T00:00:00.000Z',
      id: 'MMR-3000',
      status: 'done',
      title: 'Late edit',
      updated_at: '2026-06-25T00:00:00.000Z',
    });
    mockTerminalApi([...finishedTasks(3), edited]);
    renderTasks('/tasks?status=terminal');
    await screen.findByText('Late edit');
    expect(titlesIn('Done · 4')).toStrictEqual([
      'Finished 0',
      'Finished 1',
      'Finished 2',
      'Late edit',
    ]);
  });

  it('leaves the other views unbounded', async () => {
    mockTerminalApi(finishedTasks(finishedCount));
    renderTasks();
    await screen.findByText('Doctor the wire');
    const reads = nodeReads();
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.has('limit')).toBe(false);
      expect(read.has('offset')).toBe(false);
    }
    expect(showMore()).toBeNull();
  });
});

describe('tasksPage grooming chips (MMR-466)', () => {
  it('shows the grooming state on todo rows only', async () => {
    const groomRows: WireNode[] = [
      task({ grooming: 'groomed', id: 'MMR-20', status: 'ready', title: 'Ready and groomed' }),
      task({
        grooming: 'needs_answers',
        id: 'MMR-21',
        status: 'ready',
        title: 'Waiting on answers',
      }),
      task({
        grooming: 'groomed',
        id: 'MMR-22',
        lifecycle: 'in_progress',
        status: 'in_progress',
        title: 'Already started',
      }),
    ];
    apiGet.mockImplementation((path: string) =>
      path.startsWith('/api/projects')
        ? Promise.resolve({ items: [], total: 0 })
        : Promise.resolve({ items: groomRows, total: groomRows.length }),
    );
    renderTasks();

    await screen.findByRole('link', { name: 'Ready and groomed' });
    expect(within(rowOf('Ready and groomed')).getByText('groomed')).toBeDefined();
    expect(within(rowOf('Waiting on answers')).getByText('needs answers')).toBeDefined();
    expect(within(rowOf('Already started')).queryByText('groomed')).toBeNull();
  });
});
