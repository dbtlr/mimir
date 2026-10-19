import type { EngineNode, EngineTree } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { projects, tree } from '../api/fns/shell';
import { browserTimeZone } from '../api/queries';
import type { WireReviewProject } from '../api/types';
import { subtreeOf } from '../lib/ancestry';
import { rememberProject } from '../lib/current-project';
import { routeTree } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { emptyRead, reviewReport, task, workReport } from './fixtures';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend: vi.fn() }));
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');

/*
 * The shell's project sidebar (ADR 0013, MMR-492 refinement): the current
 * project's header, its sections, and its initiative and phase outline. On a
 * phone it is a drawer behind a top-bar button.
 */

function node(
  id: string,
  type: EngineTree['type'],
  status: EngineTree['status'],
  children: EngineTree[] = [],
  extra: Partial<EngineTree> = {},
): EngineTree {
  return engineTree({ id, status, type, ...extra }, children);
}

/** MMR: an initiative holding a phase holding a task, a second phase, and a finished initiative. */
const TREE = node('MMR', 'project', 'in_progress', [
  node('MMR-1', 'initiative', 'in_progress', [
    node('MMR-2', 'phase', 'in_progress', [node('MMR-3', 'task', 'blocked')]),
    node('MMR-4', 'phase', 'ready'),
  ]),
  node('MMR-5', 'initiative', 'done', [node('MMR-6', 'phase', 'done')]),
  node('MMR-7', 'task', 'ready'),
  node('MMR-8', 'initiative', 'ready', [], { open_ended: true }),
  node('MMR-9', 'initiative', 'parked', [node('MMR-10', 'task', 'parked')]),
]);

function serve(
  active: EngineNode[],
  trees: Record<string, EngineTree> = {},
  review: WireReviewProject[] = [],
) {
  serveShell({
    projects: active,
    trees: {
      ...Object.fromEntries(active.map((p) => [p.id, node(p.id, 'project', p.status)])),
      MMR: TREE,
      ...trees,
    },
  });
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/review')) {
      return Promise.resolve(reviewReport({ projects: review }));
    }
    // The page itself never loads: these cases read the shell around it.
    if (path.startsWith('/api/doctor') || /^\/api\/projects\/[A-Z]+$/.test(path)) {
      return Promise.withResolvers().promise;
    }
    // A record page does load: the sidebar reads the open record's type from it.
    const nodeId = /^\/api\/nodes\/([A-Z]+-\d+)(\/work\?.*)?$/.exec(path);
    const found = nodeId?.[1] === undefined ? undefined : subtreeOf(TREE, nodeId[1]);
    if (found !== undefined) {
      return Promise.resolve(
        nodeId?.[2] === undefined
          ? task({
              id: found.id,
              parent: found.parent,
              status: found.status,
              title: found.title,
              type: found.type,
            })
          : workReport(),
      );
    }
    return Promise.resolve(emptyRead(path));
  });
}

function renderAt(initial: string) {
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

const MMR = engineProject({ id: 'MMR', title: 'Mimir' });
const NRN = engineProject({ id: 'NRN', title: 'Norn' });

function decisions(key: string, count: number): WireReviewProject {
  return { decisions: count, going_cold: 0, in_flight: 0, key, live: 0, name: key, triage: 0 };
}

const topBar = () => screen.getAllByRole('banner')[0] as HTMLElement;
const sidebar = () => screen.findByRole('navigation', { name: /^(All projects|Project)$/ });
const outline = async () => within(await sidebar()).findByRole('navigation', { name: 'Outline' });
const allHeader = (nav: HTMLElement) => within(nav).getByRole('button', { name: /^All projects/ });
const SECTIONS = ['Work', 'Tasks', 'Seeds', 'Artifacts'];

/** The sidebar's sections currently marked as the page. */
async function activeSections() {
  const nav = await sidebar();
  return SECTIONS.filter((name) =>
    ['page', 'true'].includes(
      within(nav).getByRole('link', { name }).getAttribute('aria-current') ?? '',
    ),
  );
}

beforeEach(() => {
  serveBrowse();
  localStorage.clear();
  stubViewport('desktop');
  serve([MMR]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('sidebar sections mark the page (MMR-485, MMR-496)', () => {
  it.each([
    ['/p/MMR', 'Work'],
    ['/p/MMR/tasks', 'Tasks'],
    ['/p/MMR/tasks?status=ready', 'Tasks'],
    ['/p/MMR/seeds', 'Seeds'],
    ['/p/MMR/artifacts', 'Artifacts'],
    ['/p/MMR/s41', 'Seeds'],
    ['/p/MMR/a219', 'Artifacts'],
    ['/p/MMR/2', 'Work'],
    ['/p/MMR/1?tab=timeline', 'Work'],
  ])('%s marks only %s', async (path, label) => {
    renderAt(path);
    await waitFor(async () => {
      await expect(activeSections()).resolves.toStrictEqual([label]);
    });
  });

  it('marks Tasks on a task’s page once the tree names it a task', async () => {
    renderAt('/p/MMR/3');
    await waitFor(async () => {
      await expect(activeSections()).resolves.toStrictEqual(['Tasks']);
    });
  });

  it('points the sections at the project', async () => {
    renderAt('/p/MMR');
    const nav = await sidebar();
    expect(
      SECTIONS.map((name) => within(nav).getByRole('link', { name }).getAttribute('href')),
    ).toStrictEqual(['/p/MMR', '/p/MMR/tasks', '/p/MMR/seeds', '/p/MMR/artifacts']);
  });

  it('washes the active section in the accent selection treatment, never solid', async () => {
    renderAt('/p/MMR/seeds');
    const link = within(await sidebar()).getByRole('link', { name: 'Seeds' });
    expect(link.className).toContain('aria-[current]:bg-accent/10');
    expect(link.className).toContain('aria-[current]:inset-ring-accent/28');
  });
});

describe('sidebar names the current project', () => {
  it('shows the URL’s project in the header', async () => {
    serve([MMR, NRN]);
    renderAt('/p/NRN/seeds');
    const nav = await sidebar();
    await expect(
      within(nav).findByRole('button', { name: /NRN.*Norn/ }),
    ).resolves.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Tasks' })).toHaveAttribute(
      'href',
      '/p/NRN/tasks',
    );
  });

  it('opens the project switcher from the header, with a way to start a new project', async () => {
    renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: /MMR.*Mimir/ }));
    await expect(
      screen.findByRole('button', { name: '+ New project' }),
    ).resolves.toBeInTheDocument();
  });

  it('renders no sidebar when there are no projects', async () => {
    serve([]);
    renderAt('/');
    await screen.findByRole('link', { name: 'Mimir' });
    await waitFor(() => {
      expect(projects).toHaveBeenCalledWith({
        data: { facets: ['distribution', 'tags'], status: 'active' },
      });
    });
    expect(screen.queryByRole('navigation', { name: 'Project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open project menu' })).toBeNull();
  });
});

describe('sidebar on All projects (MMR-505)', () => {
  it.each(['/', '/doctor'])(
    'reads All projects on %s, whatever project was last visited',
    async (path) => {
      serve([MMR, NRN]);
      rememberProject('NRN');
      renderAt(path);
      const nav = await sidebar();
      expect(allHeader(nav)).toBeInTheDocument();
      expect(within(nav).queryByRole('button', { name: /NRN/ })).toBeNull();
    },
  );

  it.each(['/', '/doctor'])(
    'holds only Work on %s: no outline, Tasks, Seeds, or Artifacts',
    async (path) => {
      serve([MMR]);
      renderAt(path);
      const nav = await sidebar();
      expect(
        within(nav)
          .getAllByRole('link')
          .map((l) => l.textContent),
      ).toStrictEqual(['Work']);
      expect(within(nav).queryByRole('navigation', { name: 'Outline' })).toBeNull();
      expect(tree).not.toHaveBeenCalled();
    },
  );

  it('links Work to / and marks it the page there', async () => {
    renderAt('/');
    const work = within(await sidebar()).getByRole('link', { name: 'Work' });
    expect(work).toHaveAttribute('href', '/');
    expect(work).toHaveAttribute('aria-current', 'page');
  });

  it('marks nothing as the page on /doctor', async () => {
    renderAt('/doctor');
    const work = within(await sidebar()).getByRole('link', { name: 'Work' });
    expect(work).toHaveAttribute('href', '/');
    expect(work).not.toHaveAttribute('aria-current');
  });

  it('counts the decisions across every project in the header', async () => {
    serve([MMR, NRN], {}, [decisions('MMR', 2), decisions('NRN', 3)]);
    renderAt('/');
    const header = await within(await sidebar()).findByRole('button', {
      name: /^All projects.*5 decisions/,
    });
    expect(header).toHaveTextContent('5');
  });

  it('says nothing of decisions when none wait', async () => {
    serve([MMR, NRN], {}, [decisions('MMR', 0)]);
    renderAt('/');
    const nav = await sidebar();
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(
        `/api/review?tz=${encodeURIComponent(browserTimeZone())}`,
      );
    });
    expect(allHeader(nav)).toHaveAccessibleName('All projects');
  });

  it('has no "elsewhere" count', async () => {
    serve([MMR, NRN], {}, [decisions('MMR', 2), decisions('NRN', 3)]);
    renderAt('/');
    await within(await sidebar()).findByRole('button', { name: /5 decisions/ });
    expect(screen.queryByText(/elsewhere/)).toBeNull();
  });

  it('still leaves bare /tasks to the remembered project', async () => {
    serve([MMR, NRN]);
    rememberProject('NRN');
    const testRouter = renderAt('/tasks');
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/NRN/tasks');
    });
  });

  it('returns to the project context on a project page', async () => {
    serve([MMR, NRN]);
    const testRouter = renderAt('/');
    const nav = await sidebar();
    expect(allHeader(nav)).toBeInTheDocument();
    await act(async () => {
      await testRouter.navigate({ params: { key: 'NRN' }, to: '/p/$key' });
    });
    await expect(
      within(await sidebar()).findByRole('button', { name: /NRN.*Norn/ }),
    ).resolves.toBeInTheDocument();
    expect(within(await sidebar()).getByRole('link', { name: 'Seeds' })).toBeInTheDocument();
  });
});

describe('sidebar landmarks name their context (MMR-505)', () => {
  it.each(['/', '/doctor'])('are All projects on %s', async (path) => {
    renderAt(path);
    await screen.findByRole('navigation', { name: 'All projects' });
    expect(screen.getByRole('complementary', { name: 'All projects' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Project' })).toBeNull();
  });

  it('stay Project on a project page', async () => {
    renderAt('/p/MMR');
    await sidebar();
    expect(screen.getByRole('complementary', { name: 'Project' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'All projects' })).toBeNull();
  });

  it('name the drawer All projects on / and Project on a project page', async () => {
    stubViewport('phone');
    const testRouter = renderAt('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'All projects' });
    expect(within(drawer).getByRole('navigation', { name: 'All projects' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await act(async () => {
      await testRouter.navigate({ params: { key: 'MMR' }, to: '/p/$key' });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    await expect(screen.findByRole('dialog', { name: 'Project' })).resolves.toBeInTheDocument();
  });
});

describe('sidebar outline', () => {
  it('lists initiatives and phases, each linked to its page, and not tasks', async () => {
    renderAt('/p/MMR');
    const nav = await outline();
    const link = await within(nav).findByRole('link', { name: /initiative MMR-1/ });
    expect(link).toHaveAttribute('href', '/p/MMR/1');
    expect(within(nav).getByRole('link', { name: /phase MMR-2/ })).toHaveAttribute(
      'href',
      '/p/MMR/2',
    );
    expect(within(nav).queryByText(/task MMR-7/)).toBeNull();
    expect(within(nav).getByText('0/2')).toBeInTheDocument();
  });

  it('tallies each row: done over total, ∞ when open-ended, parked when parked', async () => {
    renderAt('/p/MMR');
    const nav = await outline();
    const rowOf = async (name: RegExp) => within(nav).findByRole('link', { name });
    await expect(rowOf(/initiative MMR-1/)).resolves.toHaveTextContent('0/2');
    await expect(rowOf(/initiative MMR-8/)).resolves.toHaveTextContent('∞');
    await expect(rowOf(/initiative MMR-9/)).resolves.toHaveTextContent('parked');
  });

  it('opens the fold on a click to show the finished initiatives', async () => {
    renderAt('/p/MMR');
    const nav = await outline();
    await within(nav).findByRole('link', { name: /initiative MMR-1/ });
    expect(within(nav).getByText('initiative MMR-5')).not.toBeVisible();
    await userEvent.click(within(nav).getByText('1 finished initiative'));
    expect(within(nav).getByText('initiative MMR-5')).toBeVisible();
  });

  it('marks nothing as the page on the project’s own page', async () => {
    renderAt('/p/MMR');
    const nav = await outline();
    await within(nav).findByRole('link', { name: /phase MMR-2/ });
    expect(within(nav).queryAllByRole('link', { current: 'page' })).toHaveLength(0);
  });

  it('marks a phase’s page and the initiative above it', async () => {
    renderAt('/p/MMR/2');
    const nav = await outline();
    const phase = await within(nav).findByRole('link', { name: /phase MMR-2/ });
    await waitFor(() => {
      expect(phase).toHaveAttribute('aria-current', 'page');
    });
    expect(within(nav).getByRole('link', { name: /initiative MMR-1/ })).toHaveAttribute(
      'data-on-path',
      'true',
    );
    expect(within(nav).getByRole('link', { name: /phase MMR-4/ })).not.toHaveAttribute(
      'data-on-path',
    );
  });

  it('places a task under its nearest container, with the containers above it on its path', async () => {
    renderAt('/p/MMR/3');
    const nav = await outline();
    const taskRow = await within(nav).findByRole('link', { name: /task MMR-3/ });
    expect(taskRow).toHaveAttribute('aria-current', 'page');
    expect(taskRow).toHaveAttribute('href', '/p/MMR/3');
    expect(within(nav).getByRole('link', { name: /phase MMR-2/ })).toHaveAttribute(
      'data-on-path',
      'true',
    );
    expect(within(nav).getByRole('link', { name: /initiative MMR-1/ })).toHaveAttribute(
      'data-on-path',
      'true',
    );
    const rows = within(nav)
      .getAllByRole('link')
      .map((l) => l.textContent);
    expect(rows.findIndex((t) => t?.includes('MMR-3'))).toBe(
      rows.findIndex((t) => t?.includes('phase MMR-2')) + 1,
    );
  });

  it('opens the finished-initiatives fold when the open record is inside one', async () => {
    renderAt('/p/MMR/6');
    const nav = await outline();
    const phase = await within(nav).findByRole('link', { name: /phase MMR-6/ });
    expect(phase).toBeVisible();
    expect(nav.querySelector('details')).toHaveAttribute('open');
  });

  it('reopens a fold shut by hand when the next open record is inside it too', async () => {
    const testRouter = renderAt('/p/MMR/6');
    const nav = await outline();
    await within(nav).findByRole('link', { name: /phase MMR-6/ });
    await userEvent.click(within(nav).getByText('1 finished initiative'));
    expect(nav.querySelector('details')).not.toHaveAttribute('open');

    await act(async () => {
      await testRouter.navigate({ params: { key: 'MMR', seq: '5' }, to: '/p/$key/$seq' });
    });
    await within(nav).findByRole('link', { name: /initiative MMR-5/ });
    expect(nav.querySelector('details')).toHaveAttribute('open');
  });

  it('keeps the fold shut otherwise', async () => {
    renderAt('/p/MMR/2');
    const nav = await outline();
    await within(nav).findByRole('link', { name: /phase MMR-2/ });
    expect(nav.querySelector('details')).not.toHaveAttribute('open');
    expect(within(nav).getByText('1 finished initiative')).toBeInTheDocument();
  });

  it('says so when the tree cannot be read', async () => {
    vi.mocked(tree).mockRejectedValue(new Error('down'));
    renderAt('/p/MMR');
    await expect(screen.findByText('Couldn’t load the structure.')).resolves.toBeInTheDocument();
  });
});

describe('sidebar on an archived project (MMR-506)', () => {
  const OLD = engineProject({
    archivedAt: new Date('2026-09-30T15:00:00.000Z'),
    id: 'OLD',
    status: 'done',
    title: 'Old project',
  });

  /** `OLD` is archived: its record and tree 404, and the archived list names it. */
  function serveArchived() {
    const served = apiGet.getMockImplementation();
    vi.mocked(projects).mockImplementation(async ({ data }) =>
      data.status === 'archived' ? [OLD] : [MMR],
    );
    const servedTree = vi.mocked(tree).getMockImplementation();
    vi.mocked(tree).mockImplementation(async (options) => {
      if (options.data.id === 'OLD') {
        throw new ApiError('tree OLD → 404', 404);
      }
      return servedTree?.(options) as Promise<EngineTree>;
    });
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/projects/OLD')) {
        return Promise.reject(new ApiError(`GET ${path} → 404`, 404));
      }
      return served?.(path);
    });
  }

  it('keeps the header and offers only Work, with no outline, browsers, or error line', async () => {
    serveArchived();
    renderAt('/p/OLD');

    const nav = await sidebar();
    expect(within(nav).getByRole('button', { name: /OLD/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(within(nav).getByRole('link', { name: 'Work' })).toBeInTheDocument();
    });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toStrictEqual(['Work']);
    expect(within(nav).queryByRole('navigation', { name: 'Outline' })).toBeNull();
    expect(within(nav).queryByText('Couldn’t load the structure.')).toBeNull();
  });
});

/** Every sidebar link marked as the current page. */
const pageMarks = async () =>
  within(await sidebar())
    .getAllByRole('link', { current: 'page' })
    .map((l) => l.textContent);

describe('sidebar announces where the page is', () => {
  it('marks the phase row as the page and its section as a softer current, not both as the page', async () => {
    renderAt('/p/MMR/2');
    const nav = await sidebar();
    await waitFor(async () => {
      await expect(pageMarks()).resolves.toStrictEqual([expect.stringContaining('phase MMR-2')]);
    });
    expect(within(nav).getByRole('link', { name: 'Work' })).toHaveAttribute('aria-current', 'true');
  });

  it('marks a task’s row as the page and Tasks as the current section', async () => {
    renderAt('/p/MMR/3');
    const nav = await sidebar();
    await waitFor(async () => {
      await expect(pageMarks()).resolves.toStrictEqual([expect.stringContaining('task MMR-3')]);
    });
    expect(within(nav).getByRole('link', { name: 'Tasks' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('marks a browser’s section as the page itself, since no row stands for it', async () => {
    renderAt('/p/MMR/seeds');
    const nav = await sidebar();
    await waitFor(() => {
      expect(within(nav).getByRole('link', { name: 'Seeds' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });
  });

  it('says in words that a ringed ancestor contains the page', async () => {
    renderAt('/p/MMR/3');
    const nav = await outline();
    const initiative = await within(nav).findByRole('link', { name: /initiative MMR-1/ });
    await waitFor(() => {
      expect(initiative).toHaveAccessibleName(/contains this page/);
    });
    expect(within(nav).getByRole('link', { name: /phase MMR-4/ })).not.toHaveAccessibleName(
      /contains this page/,
    );
  });

  it('puts a task’s page under Tasks from its own record, without the tree', async () => {
    vi.mocked(tree).mockRejectedValue(new Error('down'));
    renderAt('/p/MMR/3');
    await waitFor(async () => {
      await expect(activeSections()).resolves.toStrictEqual(['Tasks']);
    });
  });

  it('names the sidebar landmark', async () => {
    renderAt('/p/MMR');
    await sidebar();
    expect(screen.getByRole('complementary', { name: 'Project' })).toBeInTheDocument();
  });

  it('offers a skip link before everything else that moves focus to the page', async () => {
    renderAt('/p/MMR/2');
    await screen.findByRole('heading', { level: 1 });
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(document.body.querySelector('a')).toBe(skip);

    await userEvent.click(skip);

    expect(screen.getByRole('main')).toHaveFocus();
  });
});

describe('sidebar breakpoint', () => {
  it('is a drawer on a tablet, where the page rail needs the width', async () => {
    stubViewport('tablet');
    renderAt('/p/MMR/2');
    const open = await screen.findByRole('button', { name: 'Open project menu' });
    expect(screen.queryByRole('complementary', { name: 'Project' })).toBeNull();
    await userEvent.click(open);
    await expect(screen.findByRole('dialog', { name: 'Project' })).resolves.toBeInTheDocument();
  });

  it('keeps the parent link on a tablet and hides it from desktop', async () => {
    stubViewport('tablet');
    renderAt('/p/MMR/3');
    const parent = await screen.findByRole('link', { name: /phase MMR-2/ });
    expect(parent.className).toContain('lg:hidden');
  });

  it('moves the desktop toasts clear of the sidebar', async () => {
    renderAt('/p/MMR');
    await sidebar();
    toast('Saved');
    const toaster = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-sonner-toaster]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(toaster.style.getPropertyValue('--offset-left')).toContain('16rem');
  });

  it('leaves the toasts at the edge when there is no sidebar', async () => {
    serve([]);
    renderAt('/');
    await screen.findByRole('link', { name: 'Mimir' });
    toast('Saved');
    const toaster = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-sonner-toaster]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(toaster.style.getPropertyValue('--offset-left')).not.toContain('16rem');
  });
});

describe('top bar', () => {
  it('keeps the brand, the jump palette, Needs you, and the theme toggle', async () => {
    const served = apiGet.getMockImplementation();
    apiGet.mockImplementation((path: string) =>
      path.startsWith('/api/review')
        ? Promise.resolve(reviewReport({ queue: ['MMR-52'] }))
        : served?.(path),
    );
    renderAt('/p/MMR/tasks');
    await sidebar();
    const bar = topBar();
    expect(within(bar).getByRole('link', { name: 'Mimir' })).toHaveAttribute('href', '/');
    expect(within(bar).getByRole('button', { name: 'Jump to…' })).toBeInTheDocument();
    await expect(within(bar).findByRole('button', { name: /need/i })).resolves.toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /theme/i })).toBeInTheDocument();
  });

  it('carries no section links, project picker, or overflow menu', async () => {
    renderAt('/p/MMR/tasks');
    await sidebar();
    const bar = topBar();
    for (const name of SECTIONS) {
      expect(within(bar).queryByRole('link', { name })).toBeNull();
    }
    expect(within(bar).queryByRole('button', { name: 'More' })).toBeNull();
    expect(within(bar).queryByRole('button', { name: /MMR/ })).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Open project menu' })).toBeNull();
  });
});

describe('sidebar drawer on a phone', () => {
  beforeEach(() => {
    stubViewport('phone');
  });

  it('shows no inline sidebar, only a top-bar button that opens it', async () => {
    renderAt('/p/MMR/tasks');
    const open = await screen.findByRole('button', { name: 'Open project menu' });
    expect(within(topBar()).getByRole('button', { name: 'Open project menu' })).toBe(open);
    expect(screen.queryByRole('navigation', { name: 'Project' })).toBeNull();

    await userEvent.click(open);
    const drawer = await screen.findByRole('dialog', { name: 'Project' });
    const nav = within(drawer).getByRole('navigation', { name: 'Project' });
    expect(within(nav).getByRole('link', { name: 'Tasks' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('button', { name: /MMR.*Mimir/ })).toBeInTheDocument();
  });

  it('closes on Escape and hands focus back to the button', async () => {
    renderAt('/p/MMR');
    const open = await screen.findByRole('button', { name: 'Open project menu' });
    await userEvent.click(open);
    await screen.findByRole('dialog', { name: 'Project' });

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    });
    expect(open).toHaveFocus();
  });

  it('moves focus into the drawer when it opens', async () => {
    renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project' });
    await waitFor(() => {
      expect(drawer).toContainElement(document.activeElement as HTMLElement);
    });
  });

  it('closes when a section is chosen', async () => {
    const testRouter = renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project' });

    await userEvent.click(within(drawer).getByRole('link', { name: 'Seeds' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    });
    expect(testRouter.state.location.pathname).toBe('/p/MMR/seeds');
  });

  it('closes when the page changes some other way, such as Back or the jump palette', async () => {
    const testRouter = renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    await screen.findByRole('dialog', { name: 'Project' });

    await act(async () => {
      await testRouter.navigate({ params: { key: 'MMR', seq: '2' }, to: '/p/$key/$seq' });
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    });
  });

  it('closes on the scrim', async () => {
    renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    await screen.findByRole('dialog', { name: 'Project' });

    await userEvent.click(screen.getByTestId('project-drawer-scrim'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    });
  });

  it('opens on / with the All projects context: only Work, and it closes behind a pick', async () => {
    serve([MMR, NRN], {}, [decisions('MMR', 1)]);
    const testRouter = renderAt('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'All projects' });
    const nav = within(drawer).getByRole('navigation', { name: 'All projects' });
    await expect(
      within(nav).findByRole('button', { name: /^All projects.*1 decision/ }),
    ).resolves.toBeInTheDocument();
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toStrictEqual(['Work']);
    expect(within(nav).getByRole('link', { name: 'Work' })).toHaveAttribute('aria-current', 'page');

    await userEvent.click(within(nav).getByRole('button', { name: /^All projects/ }));
    await userEvent.click(await screen.findByRole('option', { name: /NRN/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'All projects' })).toBeNull();
    });
    expect(testRouter.state.location.pathname).toBe('/p/NRN');
  });

  it('has no drawer button with no projects', async () => {
    serve([]);
    renderAt('/');
    await screen.findByRole('link', { name: 'Mimir' });
    await waitFor(() => {
      expect(projects).toHaveBeenCalledWith({
        data: { facets: ['distribution', 'tags'], status: 'active' },
      });
    });
    expect(screen.queryByRole('button', { name: 'Open project menu' })).toBeNull();
  });
});

describe('sidebar on a desktop', () => {
  it('has no drawer button', async () => {
    renderAt('/p/MMR');
    await sidebar();
    expect(screen.queryByRole('button', { name: 'Open project menu' })).toBeNull();
  });
});
