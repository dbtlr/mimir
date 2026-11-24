import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { FINISHED_PAGE_SIZE } from '../api/browse-queries';
import { list } from '../api/fns/browse';
import { tasksRoute } from '../router';
import { taskSet } from './browse-fixtures';
import { failBrowseReads, serveBrowse, serveListSelecting } from './browse-fns';
import { engineTask } from './node-fixtures';
import { renderRoute } from './router';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
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

function mockApi() {
  serveBrowse({ tasks: rows });
}

async function renderTasks(initial = '/p/MMR/tasks') {
  const { router } = await renderRoute(
    [tasksRoute],
    initial,
    new QueryClient({
      defaultOptions: { queries: { refetchInterval: false, retry: false } },
    }),
  );
  return router;
}

const search = (r: Awaited<ReturnType<typeof renderTasks>>) =>
  r.state.location.search as { status?: string; q?: string; show?: string };

/** The task-list reads issued so far, as the `list` inputs they sent. */
const nodeReads = () => vi.mocked(list).mock.calls.map(([{ data }]) => data);

/** The group headings on the page, in order (e.g. `Ready 2`). */
const groupHeadings = () =>
  screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');

/** The card titles inside one group, top to bottom. */
const titlesIn = (heading: string) =>
  within(screen.getByRole('region', { name: heading }))
    .getAllByRole('button', { expanded: false })
    .map((card) => card.textContent);

/** The chip that opens the Filter sheet. */
const filterChip = () => screen.getByRole('button', { name: /^Filter/ });

/** A task's card, found from its title. */
const cardOf = (title: string) => {
  const card = screen.getByRole('button', { name: title }).closest('[data-slot="feed-card"]');
  if (card === null) {
    throw new Error(`no card for ${title}`);
  }
  return card as HTMLElement;
};

describe('tasksPage (the Tasks list, MMR-454, MMR-724)', () => {
  it('groups live tasks by status in the stated order, folds the finished ones, and reads the live selection with the lede', async () => {
    mockApi();
    await renderTasks();
    await screen.findByText('Doctor the wire');
    expect(groupHeadings()).toStrictEqual(['Under review 1', 'Ready 2', 'Finished 2']);
    // newest activity first inside a group
    expect(titlesIn('Ready 2')).toStrictEqual(['Hoist the lookup', 'Doctor the wire']);
    expect(screen.getByText('5 live tasks')).toBeDefined();
    expect(nodeReads()).toContainEqual({
      facets: ['home', 'lede'],
      project: 'MMR',
      status: 'live',
    });
  });

  it('each card states its status and ID, and opens a preview with the lede and the task’s page', async () => {
    mockApi();
    const testRouter = await renderTasks();
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    const card = screen.getByRole('button', { name: 'Review the cutover' });
    expect(card).toHaveAccessibleDescription(/^Under review MMR-11/);
    await user.click(card);
    const preview = await screen.findByRole('dialog', { name: 'Review the cutover' });
    expect(within(preview).getByText('The lede wins.')).toBeVisible();
    expect(within(preview).queryByText('The summary loses.')).toBeNull();
    expect(within(preview).getByText('Storage cutover')).toBeVisible();
    const open = within(preview).getByRole('link', { name: 'Open MMR-11' });
    expect(open).toHaveAttribute('href', '/p/MMR/11');
    await user.click(open);
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR/11');
    });
  });

  it('a deep-linked status beyond the live ones shows its own removable chip, and removing it returns to every live task', async () => {
    mockApi();
    const testRouter = await renderTasks('/p/MMR/tasks?status=ready,done');
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    expect(nodeReads().some((p) => JSON.stringify(p.status) === '["ready","done"]')).toBe(true);
    expect(screen.getByText('5 tasks')).toBeDefined();
    expect(filterChip()).toHaveAccessibleName('Filter');

    await user.click(screen.getByRole('button', { name: 'Remove Ready, Done' }));
    await waitFor(() => {
      expect(search(testRouter).status).toBeUndefined();
    });
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
  });

  it('a deep-linked live status narrows every live task under Filter, with no chip of its own', async () => {
    mockApi();
    await renderTasks('/p/MMR/tasks?status=ready');
    await screen.findByText('Doctor the wire');
    expect(nodeReads().some((p) => p.status === 'ready')).toBe(true);
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(filterChip()).toHaveAccessibleName('Filter, 1 applied');
  });

  it('keeps an old Finished link: ?status=terminal filters, folds by day, and windows', async () => {
    mockApi();
    await renderTasks('/p/MMR/tasks?status=terminal');
    await screen.findByRole('button', { name: 'Remove Finished' });
    expect(nodeReads()).toContainEqual({
      facets: ['home', 'lede'],
      limit: FINISHED_PAGE_SIZE,
      project: 'MMR',
      status: 'terminal',
    });
  });

  it('treats an empty status in the URL as every live task with no removable chip', async () => {
    mockApi();
    await renderTasks('/p/MMR/tasks?status=');
    await screen.findByText('Doctor the wire');
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(nodeReads().some((p) => p.status === 'live')).toBe(true);
  });

  it('survives a numeric status in the URL', async () => {
    mockApi();
    await renderTasks('/p/MMR/tasks?status=1');
    // `1` is no status, so no task can match it.
    await screen.findByText('No tasks match.');
    expect(screen.getByRole('region', { name: 'Tasks' })).toBeDefined();
  });

  it('removing the status chip hands keyboard focus to the search box', async () => {
    mockApi();
    await renderTasks('/p/MMR/tasks?status=terminal');
    const user = userEvent.setup();
    await screen.findByText('Land the schema');
    await user.click(screen.getByRole('button', { name: 'Remove Finished' }));
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveFocus();
  });

  it('labels a deep-linked union and the all selector', async () => {
    mockApi();
    await renderTasks('/p/MMR/tasks?status=blocked,all');
    await screen.findByText('Doctor the wire');
    expect(screen.getByRole('button', { name: 'Remove Blocked, All' })).toBeDefined();
    expect(nodeReads().some((p) => JSON.stringify(p.status) === '["blocked","all"]')).toBe(true);
  });

  it('asks for no tasks when a deep-linked status names no selector', async () => {
    mockApi();
    await renderTasks('/p/MMR/tasks?status=ready,new');
    await expect(screen.findByText('No tasks match.')).resolves.toBeDefined();
    expect(nodeReads()).toStrictEqual([]);
  });

  it('restores a deep-linked search and scopes the read to the project in the path', async () => {
    mockApi();
    await renderTasks('/p/MMR/tasks?q=cutover');
    await screen.findByText('Doctor the wire');

    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'cutover');
    const read = nodeReads().find((p) => p.q === 'cutover');
    expect(read?.project).toBe('MMR');
  });

  it('typing in the search box updates q after the debounce', async () => {
    mockApi();
    const testRouter = await renderTasks();
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    const box = screen.getByRole('searchbox', { name: 'Search tasks' });
    expect(box).toHaveAttribute('placeholder', 'Search titles and IDs');
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
    await renderTasks();
    await expect(screen.findByText('No tasks match.')).resolves.toBeDefined();
  });

  it('unreachable with nothing cached keeps the honest error', async () => {
    failBrowseReads(new Error('down'));
    await renderTasks();
    await expect(
      screen.findByText(/Unreachable — is the Mimir host running\?/),
    ).resolves.toBeDefined();
  });
});

/** The page's own Show more, which loads the next window (a day's fold has its own). */
const showMore = () => screen.queryByRole('button', { name: /^Show \d+ more finished tasks$/ });

/** The count line's words. */
const countText = () => document.querySelector('[data-slot="list-count"]')?.textContent;

/** The limit of every terminal list read so far, in request order. */
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
  serveBrowse();
  vi.mocked(list).mockImplementation(async ({ data }) => {
    if (data.status !== 'terminal') {
      return taskSet(rows);
    }
    const limit = data.limit ?? all.length;
    await gate(limit);
    return taskSet(all.slice(0, limit), all.length);
  });
}

describe('tasksPage Finished windows (MMR-460)', () => {
  // Two full windows and a partial third.
  const finishedCount = FINISHED_PAGE_SIZE * 2 + 10;

  it('asks for one bounded window first and offers Show more', async () => {
    mockTerminalApi(finishedTasks(finishedCount));
    await renderTasks('/p/MMR/tasks?status=terminal');
    await screen.findByText('Finished 0');

    expect(terminalLimits()).toStrictEqual([FINISHED_PAGE_SIZE]);
    const first = nodeReads().find((p) => p.status === 'terminal');
    expect(first?.offset).toBeUndefined();
    expect(first?.facets).toContain('lede');
    expect(countText()).toBe(`${String(FINISHED_PAGE_SIZE)} of ${String(finishedCount)} finished`);
    expect(showMore()).toHaveTextContent(`Show ${String(FINISHED_PAGE_SIZE)} more`);
  });

  it('Show more asks for a larger limit, keeps the rows meanwhile, and goes once all are loaded', async () => {
    const held = Promise.withResolvers<void>();
    mockTerminalApi(finishedTasks(finishedCount), (limit) =>
      limit === FINISHED_PAGE_SIZE * 2 ? held.promise : undefined,
    );
    await renderTasks('/p/MMR/tasks?status=terminal');
    const user = userEvent.setup();
    await screen.findByText('Finished 0');

    const button = showMore() as HTMLElement;
    await user.click(button);
    // The larger read is in flight: the shown rows stay, the button keeps focus and is inert.
    await waitFor(() => {
      expect(terminalLimits()).toContain(FINISHED_PAGE_SIZE * 2);
    });
    expect(countText()).toBe(`${String(FINISHED_PAGE_SIZE)} of ${String(finishedCount)} finished`);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveFocus();
    await user.click(button);
    expect(terminalLimits().filter((l) => l === FINISHED_PAGE_SIZE * 3)).toHaveLength(0);

    held.resolve();
    await waitFor(() => {
      expect(countText()).toBe(
        `${String(FINISHED_PAGE_SIZE * 2)} of ${String(finishedCount)} finished`,
      );
    });
    expect(showMore()).toHaveTextContent('Show 10 more');
    expect(showMore()).not.toHaveAttribute('aria-disabled');

    await user.click(showMore() as HTMLElement);
    await waitFor(() => {
      expect(countText()).toBe(`${String(finishedCount)} finished`);
    });
    expect(terminalLimits()).toContain(FINISHED_PAGE_SIZE * 3);
    expect(showMore()).toBeNull();
  });

  it('has no Show more when every finished task fits one window', async () => {
    mockTerminalApi(finishedTasks(3));
    await renderTasks('/p/MMR/tasks?status=terminal');
    await screen.findByText('Finished 0');
    expect(showMore()).toBeNull();
  });

  it('keeps the shown rows, says so, and retries when the larger window fails', async () => {
    let fail = true;
    mockTerminalApi(finishedTasks(finishedCount), (limit) =>
      limit === FINISHED_PAGE_SIZE * 2 && fail ? Promise.reject(new Error('down')) : undefined,
    );
    await renderTasks('/p/MMR/tasks?status=terminal');
    const user = userEvent.setup();
    await screen.findByText('Finished 0');

    await user.click(showMore() as HTMLElement);
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent(/more finished tasks/i);
    expect(countText()).toBe(`${String(FINISHED_PAGE_SIZE)} of ${String(finishedCount)} finished`);
    expect(showMore()).not.toHaveAttribute('aria-disabled');

    fail = false;
    await user.click(showMore() as HTMLElement);
    await waitFor(() => {
      expect(countText()).toBe(
        `${String(FINISHED_PAGE_SIZE * 2)} of ${String(finishedCount)} finished`,
      );
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('starts over at one window when the view changes', async () => {
    mockTerminalApi(finishedTasks(finishedCount));
    const testRouter = await renderTasks('/p/MMR/tasks?status=terminal');
    const user = userEvent.setup();
    await screen.findByText('Finished 0');
    await user.click(showMore() as HTMLElement);
    await waitFor(() => {
      expect(terminalLimits()).toContain(FINISHED_PAGE_SIZE * 2);
    });

    await user.click(screen.getByRole('button', { name: 'Remove Finished' }));
    await screen.findByText('Doctor the wire');
    await testRouter.navigate({
      params: { key: 'MMR' },
      search: { status: 'terminal' },
      to: '/p/MMR/tasks',
    } as never);
    await waitFor(() => {
      expect(countText()).toBe(
        `${String(FINISHED_PAGE_SIZE)} of ${String(finishedCount)} finished`,
      );
    });
    expect(terminalLimits().at(-1)).toBe(FINISHED_PAGE_SIZE);
  });

  it('folds finished tasks by the day they finished, latest day open, rows by completion not last edit', async () => {
    const edited = engineTask({
      completedAt: new Date('2026-06-20T21:30:00.000Z'),
      id: 'MMR-3000',
      lifecycle: 'done',
      status: 'done',
      title: 'Late edit',
      updatedAt: new Date('2026-06-25T00:00:00.000Z'),
    });
    mockTerminalApi([...finishedTasks(3), edited]);
    await renderTasks('/p/MMR/tasks?status=terminal');
    await screen.findByText('Late edit');
    // 23:00, 22:00, 21:30, then 21:00 UTC on 20 June: the evening of Saturday 20 June in New York.
    const open = screen.getByRole('button', { expanded: true });
    expect(open).toHaveTextContent('Saturday, 20 June 4');
    const day = document.getElementById(open.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(
      within(day)
        .getAllByRole('link')
        .map((link) => link.querySelector('.block')?.textContent),
    ).toStrictEqual(['Finished 0', 'Finished 1', 'Late edit', 'Finished 2']);
  });

  it.each([
    ['/p/MMR/tasks?status=done', 'done'],
    ['/p/MMR/tasks?status=abandoned', 'abandoned'],
    ['/p/MMR/tasks?status=done,abandoned', ['done', 'abandoned']],
    ['/p/MMR/tasks?show=shipped-week&status=done', 'done'],
  ])('windows a finished-only selection too: %s', async (url, status) => {
    mockApi();
    await renderTasks(url);
    await waitFor(() => {
      expect(nodeReads()).toContainEqual(
        expect.objectContaining({ limit: FINISHED_PAGE_SIZE, status }),
      );
    });
  });

  it('leaves a selection with live statuses in it unbounded', async () => {
    mockApi();
    await renderTasks('/p/MMR/tasks?status=ready,done');
    await screen.findByText('Doctor the wire');
    expect(nodeReads().map((read) => read.limit)).not.toContain(FINISHED_PAGE_SIZE);
  });

  it('leaves the other views unbounded', async () => {
    mockTerminalApi(finishedTasks(finishedCount));
    await renderTasks();
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
    await renderTasks();

    await screen.findByRole('button', { name: 'Ready and groomed' });
    expect(within(cardOf('Ready and groomed')).getByText('groomed')).toBeDefined();
    expect(within(cardOf('Waiting on answers')).getByText('needs answers')).toBeDefined();
    expect(within(cardOf('Already started')).queryByText('groomed')).toBeNull();
  });
});

describe('tasksPage presets (MMR-724)', () => {
  // Tuesday 24 November 2026, noon in New York, the tests' browser zone: the
  // last seven days run from Wednesday 18 November through today.
  const NOW = Date.parse('2026-11-24T17:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[string, Record<string, unknown>]>([
    ['in-flight', { status: ['in_progress', 'under_review', 'staged', 'queued'] }],
    ['ready', { status: 'ready' }],
    ['going-cold', { status: 'live', verdicts: [{ negate: false, verdict: 'stale' }] }],
    [
      'shipped-week',
      {
        filters: [
          { field: 'completed_at', op: 'at-or-after', value: '2026-11-18' },
          { field: 'completed_at', op: 'at-or-before', value: '2026-11-24' },
        ],
        limit: FINISHED_PAGE_SIZE,
        status: 'done',
        timeZone: 'America/New_York',
      },
    ],
  ])('?show=%s sends its own read', async (show, read) => {
    mockApi();
    await renderTasks(`/p/MMR/tasks?show=${show}`);
    await waitFor(() => {
      expect(nodeReads()).toContainEqual({ facets: ['home', 'lede'], project: 'MMR', ...read });
    });
  });

  it.each([
    ['in-flight', 'In flight'],
    ['ready', 'Ready'],
    ['going-cold', 'Going cold'],
    ['shipped-week', 'Shipped, last 7 days'],
  ])('?show=%s shows its chip, and removing it returns to every live task', async (show, label) => {
    mockApi();
    const testRouter = await renderTasks(`/p/MMR/tasks?show=${show}`);
    const user = userEvent.setup();
    const chip = await screen.findByRole('button', { name: `Remove ${label}` });
    expect(chip).toHaveTextContent(label);

    await user.click(chip);
    await waitFor(() => {
      expect(search(testRouter).show).toBeUndefined();
    });
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    await waitFor(() => {
      expect(nodeReads().at(-1)).toStrictEqual({
        facets: ['home', 'lede'],
        project: 'MMR',
        status: 'live',
      });
    });
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveFocus();
  });

  it('ignores a show value that names no preset, as every live task', async () => {
    mockApi();
    await renderTasks('/p/MMR/tasks?show=someday');
    await screen.findByText('Doctor the wire');
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(nodeReads()).toContainEqual({
      facets: ['home', 'lede'],
      project: 'MMR',
      status: 'live',
    });
  });

  it('marks each going-cold card stale', async () => {
    serveBrowse({ tasks: [engineTask({ id: 'MMR-42', status: 'ready', title: 'Left alone' })] });
    await renderTasks('/p/MMR/tasks?show=going-cold');
    const card = (await screen.findByRole('button', { name: 'Left alone' })).closest(
      '[data-slot="feed-card"]',
    ) as HTMLElement;
    expect(within(card).getByText('⧗ stale')).toBeVisible();
  });

  it('lists a queued task under in flight, as Home’s Now counts it', async () => {
    serveListSelecting([
      engineTask({ id: 'MMR-40', lifecycle: 'in_progress', status: 'in_progress' }),
      engineTask({ id: 'MMR-43', status: 'queued', title: 'Reserved for a run' }),
      engineTask({ id: 'MMR-44', status: 'ready' }),
    ]);
    await renderTasks('/p/MMR/tasks?show=in-flight');
    await expect(screen.findByText('2 tasks in flight')).resolves.toBeVisible();
    expect(groupHeadings()).toStrictEqual(['In progress 1', 'Queued 1']);
    expect(titlesIn('Queued 1')).toStrictEqual(['Reserved for a run']);
  });

  it('says what the count line counts for each preset', async () => {
    serveBrowse({
      tasks: [
        engineTask({ id: 'MMR-40', lifecycle: 'in_progress', status: 'in_progress' }),
        engineTask({ id: 'MMR-41', status: 'under_review' }),
      ],
    });
    await renderTasks('/p/MMR/tasks?show=in-flight');
    await expect(screen.findByText('2 tasks in flight')).resolves.toBeVisible();
  });
});

describe('tasksPage Sort (MMR-724)', () => {
  /** Four ready tasks, listed out of every order the sorts give. */
  const ready = [
    engineTask({
      id: 'MMR-80',
      priority: 'p1',
      status: 'ready',
      title: 'Older p1',
      updatedAt: new Date('2026-06-11T10:00:00.000Z'),
    }),
    engineTask({
      id: 'MMR-81',
      status: 'ready',
      title: 'No priority',
      updatedAt: new Date('2026-06-11T12:00:00.000Z'),
    }),
    engineTask({
      id: 'MMR-82',
      priority: 'p0',
      status: 'ready',
      title: 'Oldest p0',
      updatedAt: new Date('2026-06-11T09:00:00.000Z'),
    }),
    engineTask({
      id: 'MMR-83',
      priority: 'p1',
      status: 'ready',
      title: 'Newer p1',
      updatedAt: new Date('2026-06-11T11:00:00.000Z'),
    }),
  ];

  it.each([
    ['', ['No priority', 'Newer p1', 'Older p1', 'Oldest p0']],
    ['?sort=oldest', ['Oldest p0', 'Older p1', 'Newer p1', 'No priority']],
    ['?sort=priority', ['Oldest p0', 'Newer p1', 'Older p1', 'No priority']],
  ])('orders a group by the URL’s sort%s', async (query, titles) => {
    serveBrowse({ tasks: ready });
    await renderTasks(`/p/MMR/tasks${query}`);
    await screen.findByText('Oldest p0');
    expect(titlesIn('Ready 4')).toStrictEqual(titles);
  });

  it('applies a sort from the sheet, counted under Filter', async () => {
    serveBrowse({ tasks: ready });
    const testRouter = await renderTasks();
    const user = userEvent.setup();
    await screen.findByText('Oldest p0');
    await user.click(filterChip());
    const sheet = await screen.findByRole('dialog', { name: 'Filter tasks' });
    const sorts = within(sheet).getByRole('radiogroup', { name: 'Sort' });
    await user.click(within(sorts).getByRole('radio', { name: 'Priority' }));
    await user.click(within(sheet).getByRole('button', { name: /^Show / }));
    await waitFor(() => {
      expect(search(testRouter)).toEqual({ sort: 'priority' });
    });
    expect(titlesIn('Ready 4')).toStrictEqual(['Oldest p0', 'Newer p1', 'Older p1', 'No priority']);
    expect(filterChip()).toHaveAccessibleName('Filter, 1 applied');
  });
});

/** Opens the Tasks list at `url` and its Filter sheet. */
async function openSheet(url = '/p/MMR/tasks') {
  const testRouter = await renderTasks(url);
  const user = userEvent.setup();
  await screen.findByText(/live tasks|in flight|ready|going cold|finished/);
  await user.click(filterChip());
  const sheet = await screen.findByRole('dialog', { name: 'Filter tasks' });
  return { sheet, testRouter, user };
}

describe('tasksPage Filter sheet (MMR-724)', () => {
  const NOW = Date.parse('2026-11-24T17:00:00.000Z');
  const tag = (name: string) => ({ createdAt: new Date(NOW), tag: name });

  /** A board for the sheet: three in flight, two ready (one cold), and two finished this week. */
  const board: EngineNode[] = [
    engineTask({
      id: 'MMR-60',
      lifecycle: 'in_progress',
      priority: 'p0',
      status: 'in_progress',
      tags: [tag('console')],
    }),
    engineTask({ id: 'MMR-61', priority: 'p1', size: 'small', status: 'under_review' }),
    engineTask({ id: 'MMR-62', size: 'large', status: 'staged', tags: [tag('engine')] }),
    engineTask({ id: 'MMR-63', status: 'ready', tags: [tag('console')] }),
    engineTask({
      id: 'MMR-64',
      status: 'ready',
      verdicts: { blocking: false, orphaned: false, stale: true },
    }),
    engineTask({
      completedAt: new Date(NOW - 3_600_000),
      id: 'MMR-65',
      lifecycle: 'done',
      size: 'large',
      status: 'done',
    }),
    engineTask({
      completedAt: new Date(NOW - 2 * 86_400_000),
      id: 'MMR-66',
      lifecycle: 'done',
      status: 'done',
    }),
  ];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    serveBrowse({ tasks: board });
    serveListSelecting(board);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['In flight', 'in-flight', 'Show 3 tasks'],
    ['Ready', 'ready', 'Show 2 tasks'],
    ['Going cold', 'going-cold', 'Show 1 task'],
    ['Shipped, last 7 days', 'shipped-week', 'Show 2 tasks'],
  ])(
    'reaches %s from the sheet, naming its count, and applies only on its button',
    async (label, show, commit) => {
      const { sheet, testRouter, user } = await openSheet();
      expect(within(sheet).getByRole('radio', { name: 'Every live task' })).toBeChecked();

      await user.click(within(sheet).getByRole('radio', { name: label }));
      await expect(within(sheet).findByRole('button', { name: commit })).resolves.toBeEnabled();
      // Nothing has applied yet.
      expect(search(testRouter).show).toBeUndefined();
      expect(screen.getByText('5 live tasks')).toBeVisible();

      await user.click(within(sheet).getByRole('button', { name: commit }));
      await waitFor(() => {
        expect(search(testRouter).show).toBe(show);
      });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(screen.getByRole('button', { name: `Remove ${label}` })).toBeVisible();
      expect(filterChip()).toHaveFocus();
    },
  );

  it('opens on what applies, and narrows a preset’s statuses with the count to match', async () => {
    const { sheet, testRouter, user } = await openSheet('/p/MMR/tasks?show=in-flight');
    expect(within(sheet).getByRole('radio', { name: 'In flight' })).toBeChecked();
    const statuses = within(sheet).getByRole('group', { name: 'Status' });
    expect(
      within(statuses)
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('aria-label')),
    ).toStrictEqual(['In progress', 'Under review', 'Staged', 'Queued']);
    expect(
      within(statuses)
        .getAllByRole('checkbox')
        .every((box) => (box as HTMLInputElement).checked),
    ).toBe(true);
    await expect(
      within(sheet).findByRole('button', { name: 'Show 3 tasks' }),
    ).resolves.toBeVisible();

    await user.click(within(statuses).getByRole('checkbox', { name: 'Staged' }));
    await user.click(within(sheet).getByRole('checkbox', { name: 'p0' }));
    const commit = await within(sheet).findByRole('button', { name: 'Show 1 task' });
    await user.click(commit);
    await waitFor(() => {
      expect(search(testRouter)).toEqual({
        priority: 'p0',
        show: 'in-flight',
        status: 'in_progress,under_review,queued',
      });
    });
    expect(nodeReads().at(-1)).toMatchObject({
      filters: [{ field: 'priority', op: 'in', value: 'p0' }],
      status: ['in_progress', 'under_review', 'queued'],
    });
    expect(filterChip()).toHaveAccessibleName('Filter, 2 applied');
  });

  it('checks every status of a Show option it changes to, dropping the last one’s narrowing', async () => {
    const { sheet, testRouter, user } = await openSheet(
      '/p/MMR/tasks?show=in-flight&status=in_progress',
    );
    await user.click(within(sheet).getByRole('radio', { name: 'Ready' }));
    const statuses = within(sheet).getByRole('group', { name: 'Status' });
    expect(within(statuses).getByRole('checkbox', { name: 'Ready' })).toBeChecked();
    await user.click(await within(sheet).findByRole('button', { name: 'Show 2 tasks' }));
    await waitFor(() => {
      expect(search(testRouter)).toEqual({ show: 'ready' });
    });
  });

  it('holds its button when no status is checked', async () => {
    const { sheet, user } = await openSheet('/p/MMR/tasks?show=ready');
    await user.click(within(sheet).getByRole('checkbox', { name: 'Ready' }));
    expect(within(sheet).getByRole('button', { name: 'Show 0 tasks' })).toBeDisabled();
  });

  it('Clear resets the fields without applying them', async () => {
    const { sheet, testRouter, user } = await openSheet('/p/MMR/tasks?show=ready&size=small');
    await user.click(within(sheet).getByRole('button', { name: 'Clear' }));
    expect(within(sheet).getByRole('radio', { name: 'Every live task' })).toBeChecked();
    expect(within(sheet).getByRole('checkbox', { name: 'Small' })).not.toBeChecked();
    expect(search(testRouter)).toEqual({ show: 'ready', size: 'small' });
    await expect(
      within(sheet).findByRole('button', { name: 'Show 5 tasks' }),
    ).resolves.toBeVisible();
  });

  it('closes on Escape without applying, and hands focus back to the Filter chip', async () => {
    const { sheet, testRouter, user } = await openSheet();
    await user.click(within(sheet).getByRole('radio', { name: 'Ready' }));
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(filterChip()).toHaveFocus();
    expect(search(testRouter).show).toBeUndefined();

    // Opening again starts from what applies, not the draft that was left.
    await user.click(filterChip());
    const again = await screen.findByRole('dialog', { name: 'Filter tasks' });
    expect(within(again).getByRole('radio', { name: 'Every live task' })).toBeChecked();
  });

  it('offers the live tasks’ tags, most used first', async () => {
    const { sheet } = await openSheet();
    const tags = await within(sheet).findByRole('group', { name: 'Tag' });
    await waitFor(() => {
      expect(
        within(tags)
          .getAllByRole('checkbox')
          .map((box) => (box as HTMLInputElement).value),
      ).toStrictEqual(['console', 'engine']);
    });
  });

  it('folds shipped-week by day, latest day open, with no status headings', async () => {
    await renderTasks('/p/MMR/tasks?show=shipped-week');
    await screen.findByText('2 shipped in the last 7 days');
    expect(screen.queryAllByRole('heading', { level: 2 })).toStrictEqual([]);
    expect(screen.getByRole('button', { expanded: true })).toHaveTextContent('Today 1');
    expect(
      screen.getByRole('button', { expanded: false, name: /^Sunday, 22 November/ }),
    ).toHaveTextContent('Sunday, 22 November 1');
    expect(screen.getByRole('link', { name: /MMR-65|task MMR-65/ })).toHaveAttribute(
      'href',
      '/p/MMR/65',
    );
  });

  it('offers only Done as shipped-week’s status, since the preset is done tasks alone', async () => {
    const { sheet, user } = await openSheet();
    await user.click(within(sheet).getByRole('radio', { name: 'Shipped, last 7 days' }));
    const statuses = within(sheet).getByRole('group', { name: 'Status' });
    expect(
      within(statuses)
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('aria-label')),
    ).toStrictEqual(['Done']);
  });

  it('keeps a link’s status selector the sheet cannot spell, under the filters it adds', async () => {
    const { sheet, testRouter, user } = await openSheet('/p/MMR/tasks?status=terminal');
    // No Show option holds the finished tasks, so none is checked, and they fold by day.
    for (const radio of within(sheet).getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
    expect(within(sheet).queryByRole('group', { name: 'Status' })).toBeNull();
    expect(within(sheet).queryByRole('radiogroup', { name: 'Sort' })).toBeNull();
    await expect(
      within(sheet).findByRole('button', { name: 'Show 2 tasks' }),
    ).resolves.toBeEnabled();

    await user.click(within(sheet).getByRole('checkbox', { name: 'Large' }));
    await user.click(await within(sheet).findByRole('button', { name: 'Show 1 task' }));
    await waitFor(() => {
      expect(search(testRouter)).toEqual({ size: 'large', status: 'terminal' });
    });
    expect(screen.getByRole('button', { name: 'Remove Finished' })).toBeVisible();
    expect(filterChip()).toHaveAccessibleName('Filter, 1 applied');
  });

  it('counts a narrowing of every live task under Filter, with no chip of its own', async () => {
    const { sheet, testRouter, user } = await openSheet();
    const statuses = within(sheet).getByRole('group', { name: 'Status' });
    await user.click(within(statuses).getByRole('checkbox', { name: 'Ready' }));
    await user.click(await within(sheet).findByRole('button', { name: 'Show 3 tasks' }));
    await waitFor(() => {
      expect(search(testRouter)).toEqual({
        status: 'in_progress,under_review,staged,queued,awaiting,blocked,parked',
      });
    });
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(filterChip()).toHaveAccessibleName('Filter, 1 applied');

    // Opening again shows the narrowing where it was made.
    await user.click(filterChip());
    const again = await screen.findByRole('dialog', { name: 'Filter tasks' });
    expect(within(again).getByRole('radio', { name: 'Every live task' })).toBeChecked();
    expect(within(again).getByRole('checkbox', { name: 'Ready' })).not.toBeChecked();
  });

  it('reads a deep-linked union with live in it as every live task, so a filter it adds keeps them all', async () => {
    const large = [
      engineTask({ id: 'MMR-70', size: 'large', status: 'ready', title: 'Large ready' }),
      engineTask({ id: 'MMR-71', size: 'large', status: 'blocked', title: 'Large blocked' }),
    ];
    serveBrowse({ tasks: large });
    serveListSelecting(large);
    const { sheet, testRouter, user } = await openSheet('/p/MMR/tasks?status=live,ready');
    const statuses = within(sheet).getByRole('group', { name: 'Status' });
    expect(
      within(statuses)
        .getAllByRole('checkbox')
        .every((box) => (box as HTMLInputElement).checked),
    ).toBe(true);

    await user.click(within(sheet).getByRole('checkbox', { name: 'Large' }));
    await user.click(await within(sheet).findByRole('button', { name: 'Show 2 tasks' }));
    await waitFor(() => {
      expect(search(testRouter)).toEqual({ size: 'large' });
    });
    await expect(screen.findByText('Large blocked')).resolves.toBeVisible();
    expect(screen.getByText('Large ready')).toBeVisible();
    expect(filterChip()).toHaveAccessibleName('Filter, 1 applied');
  });

  it('leaves a sort out of the URL once Show picks finished work, which takes none', async () => {
    const { sheet, testRouter, user } = await openSheet('/p/MMR/tasks?sort=priority');
    await user.click(within(sheet).getByRole('radio', { name: 'Shipped, last 7 days' }));
    await user.click(await within(sheet).findByRole('button', { name: 'Show 2 tasks' }));
    await waitFor(() => {
      expect(search(testRouter)).toEqual({ show: 'shipped-week' });
    });
  });

  it.each(['?show=shipped-week&sort=priority', '?status=terminal&sort=oldest'])(
    'counts no sort under Filter for finished work, which takes none (%s)',
    async (query) => {
      await renderTasks(`/p/MMR/tasks${query}`);
      await screen.findByText(/shipped in the last 7 days|finished/);
      expect(filterChip()).toHaveAccessibleName('Filter');
    },
  );

  it('offers no Sort for finished work, which folds by day', async () => {
    const { sheet, user } = await openSheet();
    expect(within(sheet).getByRole('radiogroup', { name: 'Sort' })).toBeVisible();
    await user.click(within(sheet).getByRole('radio', { name: 'Shipped, last 7 days' }));
    expect(within(sheet).queryByRole('radiogroup', { name: 'Sort' })).toBeNull();
  });
});
