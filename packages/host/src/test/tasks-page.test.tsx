import type { EngineNode } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, vi } from 'vitest';

import { FINISHED_PAGE_SIZE } from '../api/browse-queries';
import { list } from '../api/fns/browse';
import { routeTree } from '../router';
import { engineTask, taskSet } from './browse-fixtures';
import { failBrowseReads, serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { emptyRead, task } from './fixtures';
import { serveShell } from './shell-fns';
import { serveViews } from './views-fns';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

beforeEach(() => {
  serveViews();
});

/** A home facet under project MMR; `open` marks the parent as a standing home. */
function home(parentTitle: string, open = false): NonNullable<EngineNode['home']> {
  return {
    parentId: 'MMR-1',
    parentOpenEnded: open ? true : null,
    parentTitle,
    projectKey: 'MMR',
  };
}

/** Five tasks across two projects, deliberately NOT in activity order. */
const rows: EngineNode[] = [
  engineTask({
    home: home('Wire hardening'),
    id: 'MMR-10',
    lede: 'Make the wire honest.',
    status: 'ready',
    title: 'Doctor the wire',
    updatedAt: new Date('2026-06-11T10:00:00.000Z'),
  }),
  engineTask({
    home: home('Storage cutover', true),
    id: 'MMR-12',
    status: 'done',
    summary: 'The schema landed.',
    title: 'Land the schema',
    updatedAt: new Date('2026-06-10T12:00:00.000Z'),
  }),
  engineTask({
    home: home('Storage cutover', true),
    id: 'MMR-11',
    lede: 'The lede wins.',
    status: 'under_review',
    summary: 'The summary loses.',
    title: 'Review the cutover',
    updatedAt: new Date('2026-06-11T11:00:00.000Z'),
  }),
  engineTask({
    home: home('Wire hardening'),
    id: 'MMR-13',
    status: 'abandoned',
    title: 'Old dead end',
    updatedAt: new Date('2026-06-05T12:00:00.000Z'),
  }),
  engineTask({
    home: { ...home('Layer 4'), projectKey: 'NRN' },
    id: 'NRN-4',
    status: 'ready',
    title: 'Hoist the lookup',
    updatedAt: new Date('2026-06-11T12:00:00.000Z'),
  }),
];

/** Two projects; each answers the sidebar outline as a project holding no containers. */
function serveProjects(only?: string) {
  const all = [
    engineProject({ id: 'MMR', title: 'Mimir' }),
    engineProject({ id: 'NRN', status: 'ready', title: 'Norn' }),
  ];
  serveShell({ projects: only === undefined ? all : all.filter((p) => p.id === only) });
}

function mockApi() {
  serveProjects();
  serveBrowse({ tasks: rows });
  apiGet.mockImplementation((path: string) => {
    if (path.includes('/annotations')) {
      return Promise.resolve(emptyRead(path));
    }
    if (path.startsWith('/api/nodes/')) {
      // the task page's detail fetch after a row click
      return Promise.resolve(task({ id: 'MMR-10', status: 'ready', title: 'Doctor the wire' }));
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function renderTasks(initial = '/p/MMR/tasks') {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree,
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
  r.state.location.search as { status?: string; q?: string };

/** The task-list reads issued so far, as the `list` inputs they sent. */
const nodeReads = () => vi.mocked(list).mock.calls.map(([{ data }]) => data);

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
    expect(nodeReads()).toContainEqual({
      facets: ['home', 'lede'],
      project: 'MMR',
      status: 'live',
    });
  });

  it('groups only by status: no group menu, and an old group=project link is harmless', async () => {
    mockApi();
    renderTasks('/p/MMR/tasks?group=project');
    await screen.findByText('Doctor the wire');
    expect(screen.queryByRole('button', { name: /Group:/ })).toBeNull();
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
      expect(nodeReads().some((p) => p.status === 'terminal')).toBe(true);
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
    const testRouter = renderTasks('/p/MMR/tasks?status=ready');
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    expect(screen.getByRole('button', { name: 'Live' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Finished' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(nodeReads().some((p) => p.status === 'ready')).toBe(true);
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
    renderTasks('/p/MMR/tasks?status=');
    await screen.findByText('Doctor the wire');
    expect(live().getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: /Remove status filter/ })).toBeNull();
    expect(nodeReads().some((p) => p.status === 'live')).toBe(true);
  });

  it('survives a numeric status in the URL', async () => {
    mockApi();
    renderTasks('/p/MMR/tasks?status=1');
    // `1` is no status, so no task can match it.
    await screen.findByText('No tasks match.');
    expect(screen.getByRole('heading', { level: 1, name: 'Tasks' })).toBeDefined();
  });

  it('removing the status chip hands keyboard focus to the search box', async () => {
    mockApi();
    renderTasks('/p/MMR/tasks?status=ready');
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
    renderTasks('/p/MMR/tasks?status=ready,blocked');
    await screen.findByText('Doctor the wire');
    expect(
      screen.getByRole('button', { name: 'Remove status filter Ready, Blocked' }),
    ).toBeDefined();
    expect(nodeReads().some((p) => JSON.stringify(p.status) === '["ready","blocked"]')).toBe(true);
  });

  it('asks for no tasks when a deep-linked status names no selector', async () => {
    mockApi();
    renderTasks('/p/MMR/tasks?status=ready,new');
    await expect(screen.findByText('No tasks match.')).resolves.toBeDefined();
    expect(nodeReads()).toStrictEqual([]);
  });

  it('restores a deep-linked search and scopes the read to the project in the path', async () => {
    mockApi();
    renderTasks('/p/MMR/tasks?q=cutover');
    await screen.findByText('Doctor the wire');

    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'cutover');
    const read = nodeReads().find((p) => p.q === 'cutover');
    expect(read?.project).toBe('MMR');
  });

  it('has no project filter chip — the path names the project', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Doctor the wire');
    expect(screen.queryByRole('button', { name: /All projects/ })).not.toBeInTheDocument();
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
      expect(nodeReads().some((p) => p.q === 'wire')).toBe(true);
    });
  });

  it('says so when nothing matches', async () => {
    serveBrowse();
    apiGet.mockImplementation((path: string) => Promise.resolve(emptyRead(path)));
    renderTasks();
    await expect(screen.findByText('No tasks match.')).resolves.toBeDefined();
  });

  it('unreachable with nothing cached keeps the honest error and disables + New task', async () => {
    apiGet.mockRejectedValue(new Error('down'));
    failBrowseReads(new Error('down'));
    renderTasks();
    await expect(
      screen.findByText(/Unreachable — is the Mimir host running\?/),
    ).resolves.toBeDefined();
    expect(screen.getByRole('button', { name: '+ New task' })).toHaveProperty('disabled', true);
  });
});

// A text query, not a role query: naming 100+ row links costs ~150ms a call,
// which under full-suite load pushed the Show more test past its timeout.
const rowCount = () => screen.queryAllByText(/^Finished \d+$/, { selector: 'a' }).length;
const showMore = () => screen.queryByRole('button', { name: 'Show more' });

/** The `limit` of every terminal list read so far, in request order. */
const terminalLimits = () =>
  nodeReads()
    .filter((p) => p.status === 'terminal')
    .map((p) => p.limit);

/** Finished tasks, newest completion first: hour by hour, so the order is unambiguous. */
const finishedTasks = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.UTC(2026, 5, 20, 23, 0, 0) - i * 3_600_000);
    return engineTask({
      completedAt: at,
      id: `MMR-${String(1000 + i)}`,
      lifecycle: 'done',
      status: 'done',
      title: `Finished ${String(i)}`,
      updatedAt: at,
    });
  });

/**
 * Serves terminal task lists honoring `limit` like the Engine (the newest
 * `limit` of `all`, whole `total`); other lists get `rows`. `gate` lets a test
 * hold or fail a read by its limit.
 */
function mockTerminalApi(
  all: EngineNode[],
  gate: (limit: number) => Promise<void> | undefined = () => undefined,
) {
  serveProjects('MMR');
  serveBrowse();
  vi.mocked(list).mockImplementation(async ({ data }) => {
    if (data.status !== 'terminal') {
      return taskSet(rows);
    }
    const limit = data.limit ?? all.length;
    await gate(limit);
    return taskSet(all.slice(0, limit), all.length);
  });
  apiGet.mockImplementation(async (path: string) => {
    throw new Error(`unexpected ${path}`);
  });
}

describe('tasksPage Finished view windows (MMR-460)', () => {
  // Two full windows and a partial third.
  const finishedCount = FINISHED_PAGE_SIZE * 2 + 10;

  it('asks for one bounded window first and offers Show more', async () => {
    mockTerminalApi(finishedTasks(finishedCount));
    renderTasks('/p/MMR/tasks?status=terminal');
    await screen.findByText('Finished 0');

    expect(rowCount()).toBe(FINISHED_PAGE_SIZE);
    expect(terminalLimits()).toStrictEqual([FINISHED_PAGE_SIZE]);
    const first = nodeReads().find((p) => p.status === 'terminal');
    expect(first?.offset).toBeUndefined();
    expect(first?.facets).toContain('lede');
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
    renderTasks('/p/MMR/tasks?status=terminal');
    const user = userEvent.setup();
    await screen.findByText('Finished 0');

    await user.click(showMore() as HTMLElement);
    // The larger read is in flight: the shown rows stay, the button is inert.
    await waitFor(() => {
      expect(terminalLimits()).toContain(FINISHED_PAGE_SIZE * 2);
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
    expect(terminalLimits()).toContain(FINISHED_PAGE_SIZE * 3);
    expect(showMore()).toBeNull();
    expect(screen.getByText(`${String(finishedCount)} finished`)).toBeDefined();
  });

  it('has no Show more when every finished task fits one window', async () => {
    mockTerminalApi(finishedTasks(3));
    renderTasks('/p/MMR/tasks?status=terminal');
    await screen.findByText('Finished 0');
    expect(showMore()).toBeNull();
  });

  it('keeps the shown rows, says so, and retries when the larger window fails', async () => {
    let fail = true;
    mockTerminalApi(finishedTasks(finishedCount), (limit) =>
      limit === FINISHED_PAGE_SIZE * 2 && fail ? Promise.reject(new Error('down')) : undefined,
    );
    renderTasks('/p/MMR/tasks?status=terminal');
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
    renderTasks('/p/MMR/tasks?status=terminal');
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
    const edited = engineTask({
      completedAt: new Date('2026-05-01T00:00:00.000Z'),
      id: 'MMR-3000',
      lifecycle: 'done',
      status: 'done',
      title: 'Late edit',
      updatedAt: new Date('2026-06-25T00:00:00.000Z'),
    });
    mockTerminalApi([...finishedTasks(3), edited]);
    renderTasks('/p/MMR/tasks?status=terminal');
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
      expect(read.limit).toBeUndefined();
      expect(read.offset).toBeUndefined();
    }
    expect(showMore()).toBeNull();
  });
});

describe('tasksPage grooming chips (MMR-466)', () => {
  it('shows the grooming state on todo rows only', async () => {
    const groomRows: EngineNode[] = [
      engineTask({
        grooming: 'groomed',
        id: 'MMR-20',
        status: 'ready',
        title: 'Ready and groomed',
      }),
      engineTask({
        grooming: 'needs_answers',
        id: 'MMR-21',
        status: 'ready',
        title: 'Waiting on answers',
      }),
      engineTask({
        grooming: 'groomed',
        id: 'MMR-22',
        lifecycle: 'in_progress',
        status: 'in_progress',
        title: 'Already started',
      }),
    ];
    serveBrowse({ tasks: groomRows });
    apiGet.mockImplementation((path: string) => Promise.resolve(emptyRead(path)));
    renderTasks();

    await screen.findByRole('link', { name: 'Ready and groomed' });
    expect(within(rowOf('Ready and groomed')).getByText('groomed')).toBeDefined();
    expect(within(rowOf('Waiting on answers')).getByText('needs answers')).toBeDefined();
    expect(within(rowOf('Already started')).queryByText('groomed')).toBeNull();
  });
});
