import { MimirError } from '@mimir/contract';
import type { EngineNode, EngineTree } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, onTestFinished, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { getNode } from '../api/fns/nodes';
import { projects, tree } from '../api/fns/shell';
import { review } from '../api/fns/views';
import { reviewQuery } from '../api/view-queries';
import type { ReviewReport } from '../api/view-queries';
import { toast as notice } from '../components/patterns/notice';
import { subtreeOf } from '../lib/ancestry';
import { rememberProject } from '../lib/current-project';
import { serveBrowse } from './browse-fns';
import { serveDevices } from './devices-fns';
import { engineNode, engineProject, engineTree } from './engine-fixtures';
import { blocked, decision, question, report, stopped } from './needs-you-fixtures';
import type { Row } from './needs-you-fixtures';
import { serveNodes } from './node-fns';
import { servePush } from './push-fns';
import { renderShell } from './router';
import { serveShell } from './shell-fns';
import { serveT3 } from './t3-fns';
import { stubViewport } from './viewport';
import { engineReview, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('../api/fns/devices');
vi.mock('../api/fns/t3');
vi.mock('../api/fns/push');

/*
 * The shell's sidebar (ADR 0013, MMR-730 and MMR-804 refinements): Jump to,
 * the switcher, on a project's pages what needs you there, then one container
 * list at every level, a link to the parent, the current container, and its
 * child containers. On a phone it is a drawer behind a top-bar button.
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

/**
 * MMR: an initiative holding a phase with a task, an empty phase, and a direct
 * task; a finished initiative; a task under the project; an open-ended
 * initiative; and a parked one.
 */
const TREE = node(
  'MMR',
  'project',
  'in_progress',
  [
    node('MMR-1', 'initiative', 'in_progress', [
      node('MMR-2', 'phase', 'in_progress', [node('MMR-3', 'task', 'blocked')]),
      node('MMR-4', 'phase', 'ready'),
      node('MMR-11', 'task', 'ready'),
    ]),
    node('MMR-5', 'initiative', 'done', [
      node('MMR-6', 'phase', 'done', [node('MMR-12', 'task', 'done')]),
    ]),
    node('MMR-7', 'task', 'ready'),
    node('MMR-8', 'initiative', 'ready', [], { open_ended: true }),
    node('MMR-9', 'initiative', 'parked', [node('MMR-10', 'task', 'parked')]),
  ],
  { title: 'Mimir' },
);

function serve(
  active: EngineNode[],
  trees: Record<string, EngineTree> = {},
  decisionRows: ReviewReport['projects'] = [],
) {
  serveShell({
    projects: active,
    trees: {
      ...Object.fromEntries(active.map((p) => [p.id, node(p.id, 'project', p.status)])),
      MMR: TREE,
      ...trees,
    },
  });
  serveViews({ review: engineReview({ projects: decisionRows }) });
  serveNodes();
  vi.mocked(getNode).mockImplementation(async ({ data }) => {
    // The project's own record never loads.
    if (/^[A-Z]+$/.test(data.id)) {
      return Promise.withResolvers<never>().promise;
    }
    // A record page does load: the sidebar reads the open record's type from it.
    const found = subtreeOf(TREE, data.id);
    if (found === undefined) {
      throw new MimirError('not_found', `${data.id} doesn't exist`);
    }
    return engineNode({
      id: found.id,
      parent: found.parent,
      status: found.status,
      title: found.title,
      type: found.type,
    });
  });
}

const renderAt = async (initial: string) =>
  (
    await renderShell(
      initial,
      new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } }),
    )
  ).router;

const MMR = engineProject({ id: 'MMR', title: 'Mimir' });
const NRN = engineProject({ id: 'NRN', title: 'Norn' });

function needsYou(key: string, count: number): ReviewReport['projects'][number] {
  return stripRow({ key, name: key }, { needsYou: count });
}

const topBar = () => screen.getAllByRole('banner')[0] as HTMLElement;
const sidebar = () =>
  screen.findByRole('navigation', { name: /^(All projects|Project|Settings)$/ });
const allHeader = (nav: HTMLElement) => within(nav).getByRole('button', { name: /^All projects/ });

/** The sidebar's links in order, as their accessible text: everything under the switcher. */
const rowsOf = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole('link')
    .filter((link) => link.closest('details:not([open])') === null)
    .map((link) => link.textContent.replaceAll(/\s+/g, ' ').trim());

/** The sidebar's rows once `expected` has landed. */
async function expectRows(expected: string[]) {
  const nav = await sidebar();
  await waitFor(() => {
    expect(rowsOf(nav)).toStrictEqual(expected);
  });
  return nav;
}

/** Every sidebar link marked as the current page. */
const pageMarks = async () =>
  within(await sidebar())
    .queryAllByRole('link', { current: 'page' })
    .map((l) => l.textContent.replaceAll(/\s+/g, ' ').trim());

/*
 * Home's world (MMR-730): two pinned projects and two others.
 */
const atDay = (day: string) => new Date(`2026-09-${day}T00:00:00.000Z`);
const dated = (id: string, day: string, extra: Partial<EngineNode> = {}) =>
  engineProject({ id, lastActivityAt: atDay(day), title: `${id} title`, ...extra });
const FLT = dated('FLT', '08', { pinned: true });
const LOM = dated('LOM', '03', { pinned: true });
const HND = dated('HND', '09');
const MUN = dated('MUN', '07');

function serveWorld(decisionRows: ReviewReport['projects'] = [], more: EngineNode[] = []) {
  serveShell({ projects: [FLT, LOM, HND, MUN, ...more] });
  serveViews({ review: engineReview({ projects: decisionRows }) });
}

/** The keys of the projects Home lists. */
const listedKeys = (nav: HTMLElement) =>
  [...nav.querySelectorAll('a[href^="/p/"]')].map((row) => row.getAttribute('href')?.slice(3));

beforeEach(() => {
  serveBrowse();
  serveDevices();
  serveT3();
  servePush();
  serveViews();
  localStorage.clear();
  stubViewport('desktop');
  serve([MMR]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('sidebar names the current project', () => {
  it('shows the URL’s project in the header', async () => {
    serve([MMR, NRN]);
    await renderAt('/p/NRN/seeds');
    const nav = await sidebar();
    await expect(
      within(nav).findByRole('button', { name: /NRN.*Norn/ }),
    ).resolves.toBeInTheDocument();
    await expect(within(nav).findByRole('link', { name: /^NRN/ })).resolves.toHaveAttribute(
      'href',
      '/p/NRN',
    );
  });

  it('renders no sidebar when there are no projects', async () => {
    serve([]);
    await renderAt('/');
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

describe('sidebar on Home (MMR-730)', () => {
  it('reads All projects in the switcher, whatever project was last visited', async () => {
    serve([MMR, NRN]);
    rememberProject('NRN');
    await renderAt('/');
    const nav = await sidebar();
    expect(allHeader(nav)).toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: /NRN/ })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'All projects' })).toBeInTheDocument();
    expect(tree).not.toHaveBeenCalled();
  });

  it('is Home, washed as the page, with no dot and the active projects counted', async () => {
    serveWorld();
    await renderAt('/');
    const nav = await sidebar();
    const home = await within(nav).findByRole('link', { name: 'Home, 4 projects' });
    expect(home).toHaveAttribute('href', '/');
    expect(home).toHaveAttribute('aria-current', 'page');
    expect(home.querySelector('[class*="rounded-full"]')).toBeNull();
    expect(home.className).toContain('aria-[current=page]:bg-accent/10');
  });

  it('lists the projects as its children, with no Work row, no browsers, and no parent link', async () => {
    serveWorld();
    await renderAt('/');
    const nav = await expectRows([
      'Home 4, 4 projects',
      'FLT FLT title, In progress',
      'LOM LOM title, In progress',
      'HND HND title, In progress',
      'MUN MUN title, In progress',
      'See all 4 projects',
    ]);
    expect(within(nav).getByRole('link', { name: /^FLT/ })).toHaveAttribute('href', '/p/FLT');
  });

  it('draws its projects with the container row every level shares', async () => {
    serveWorld();
    await renderAt('/');
    const nav = await sidebar();
    const flt = await within(nav).findByRole('link', { name: /^FLT/ });
    expect(flt.closest('li')).toBeNull();
    expect(flt.className).not.toContain('hover:text-ink-bright');
    expect(flt.className).toContain('aria-[current=page]:inset-ring-accent');
    expect(within(flt).getByText('FLT')).toHaveClass('w-10');
  });

  it('leads with the projects that need you, most first, with their counts', async () => {
    serveWorld([needsYou('MUN', 1), needsYou('HND', 3)]);
    await renderAt('/');
    const nav = await sidebar();
    await waitFor(() => {
      expect(listedKeys(nav)).toStrictEqual(['HND', 'MUN', 'FLT', 'LOM']);
    });
    await expect(
      within(nav).findByRole('link', { name: /^HND.*3 need you/ }),
    ).resolves.toBeInTheDocument();
    const count = within(within(nav).getByRole('link', { name: /^MUN/ })).getByText('1');
    expect(count).toHaveClass('text-attention-foreground');
  });

  it('holds six rows, then See all counting every active project', async () => {
    serveWorld([], [dated('ZED', '01'), dated('YAK', '02'), dated('XEN', '04')]);
    await renderAt('/');
    const nav = await sidebar();
    await waitFor(() => {
      expect(listedKeys(nav)).toStrictEqual(['FLT', 'LOM', 'HND', 'MUN', 'XEN', 'YAK']);
    });
    expect(within(nav).getByRole('link', { name: 'See all 7 projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
  });

  it('counts one project as one in See all', async () => {
    await renderAt('/');
    await expect(
      within(await sidebar()).findByRole('link', { name: 'See all 1 project' }),
    ).resolves.toHaveAttribute('href', '/projects');
  });

  it('opens a project with a click', async () => {
    serveWorld();
    const testRouter = await renderAt('/');
    await userEvent.click(await within(await sidebar()).findByRole('link', { name: /^LOM/ }));
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/LOM');
    });
  });

  it('shows a skeleton while the projects load, and no See all yet', async () => {
    rememberProject('MMR');
    vi.mocked(projects).mockReturnValue(Promise.withResolvers<never>().promise);
    await renderAt('/');
    const nav = await sidebar();
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(nav.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(within(nav).queryByRole('link', { name: /See all/ })).toBeNull();
  });

  it('says so when the project list cannot be read', async () => {
    serveWorld();
    rememberProject('FLT');
    vi.mocked(projects).mockRejectedValue(new Error('unreachable'));
    await renderAt('/');
    const nav = await sidebar();
    await expect(
      within(nav).findByText('Couldn’t load the projects.'),
    ).resolves.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: /See all/ })).toBeNull();
  });

  it.each(['/projects', '/needs-you', '/doctor', '/nowhere'])(
    'rings Home on %s, which it holds, and says so in words',
    async (path) => {
      serveWorld();
      await renderAt(path);
      const nav = await sidebar();
      const home = await within(nav).findByRole('link', { name: /^Home, 4 projects/ });
      expect(home).not.toHaveAttribute('aria-current');
      expect(home).toHaveAccessibleName('Home, 4 projects, contains this page');
      expect(home).toHaveAttribute('data-holds', 'true');
    },
  );

  it('marks See all as the page on the Projects list', async () => {
    serveWorld();
    await renderAt('/projects');
    await waitFor(async () => {
      await expect(pageMarks()).resolves.toStrictEqual(['See all 4 projects']);
    });
  });

  it('returns to the project context on a project page', async () => {
    serve([MMR, NRN]);
    const testRouter = await renderAt('/');
    const nav = await sidebar();
    expect(allHeader(nav)).toBeInTheDocument();
    await act(async () => {
      await testRouter.navigate({ params: { key: 'NRN' }, to: '/p/$key' });
    });
    await expect(
      within(await sidebar()).findByRole('button', { name: /NRN.*Norn/ }),
    ).resolves.toBeInTheDocument();
    await expect(
      within(await sidebar()).findByRole('link', { name: '← Home' }),
    ).resolves.toBeInTheDocument();
  });

  it('closes the phone drawer behind a pick', async () => {
    stubViewport('phone');
    serveWorld();
    const testRouter = await renderAt('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'All projects' });
    await userEvent.click(await within(drawer).findByRole('link', { name: /^FLT/ }));
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/FLT');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('sidebar landmarks name their context (MMR-505)', () => {
  it('stay Project on a project page', async () => {
    await renderAt('/p/MMR');
    await sidebar();
    expect(screen.getByRole('complementary', { name: 'Project' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'All projects' })).toBeNull();
  });

  it('name the drawer All projects on / and Project on a project page', async () => {
    stubViewport('phone');
    const testRouter = await renderAt('/');
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

describe('sidebar on a project (MMR-730)', () => {
  it('leads back to Home, washes the project as the page, and lists its live initiatives', async () => {
    await renderAt('/p/MMR');
    const nav = await expectRows([
      '← Home',
      'MMR Mimir 1/5, In progress',
      'initiative MMR-1 0/3, In progress',
      'initiative MMR-8 ∞, Ready',
      'initiative MMR-9 parked, Parked',
    ]);
    expect(within(nav).getByRole('link', { name: '← Home' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: /^MMR Mimir/ })).toHaveAttribute('href', '/p/MMR');
    expect(within(nav).getByRole('link', { name: /initiative MMR-1/ })).toHaveAttribute(
      'href',
      '/p/MMR/1',
    );
    await expect(pageMarks()).resolves.toStrictEqual(['MMR Mimir 1/5, In progress']);
  });

  it('sets the project’s key in the switcher row’s key column', async () => {
    await renderAt('/p/MMR');
    const nav = await sidebar();
    const project = await within(nav).findByRole('link', { name: /^MMR Mimir/ });
    expect(within(project).getByText('MMR')).toHaveClass('w-10');
  });

  it('keeps the project the page on its Details tab', async () => {
    await renderAt('/p/MMR?tab=details');
    await waitFor(async () => {
      await expect(pageMarks()).resolves.toStrictEqual(['MMR Mimir 1/5, In progress']);
    });
  });

  it('shows no task, no Work row, and no Tasks, Seeds, or Artifacts rows', async () => {
    await renderAt('/p/MMR');
    const nav = await expectRows([
      '← Home',
      'MMR Mimir 1/5, In progress',
      'initiative MMR-1 0/3, In progress',
      'initiative MMR-8 ∞, Ready',
      'initiative MMR-9 parked, Parked',
    ]);
    for (const name of ['Work', 'Tasks', 'Seeds', 'Artifacts', /task MMR-7/, /phase MMR-2/]) {
      expect(within(nav).queryByRole('link', { name })).toBeNull();
    }
  });

  it('folds the finished initiatives into one closed row, in the singular for one', async () => {
    await renderAt('/p/MMR');
    const nav = await sidebar();
    const fold = await within(nav).findByText('1 finished initiative');
    expect(within(nav).getByRole('link', { name: /initiative MMR-5/ })).not.toBeVisible();
    await userEvent.click(fold);
    const finished = within(nav).getByRole('link', { name: /initiative MMR-5/ });
    expect(finished).toBeVisible();
    expect(finished).toHaveAttribute('href', '/p/MMR/5');
    // The fold holds rows, not disclosures of their own.
    expect(within(nav).queryByRole('button', { name: /Contents of/ })).toBeNull();
  });

  it('closes the fold again on the next navigation', async () => {
    const testRouter = await renderAt('/p/MMR');
    const nav = await sidebar();
    await userEvent.click(await within(nav).findByText('1 finished initiative'));
    expect(nav.querySelector('details')).toHaveAttribute('open');
    await act(async () => {
      await testRouter.navigate({ params: { key: 'MMR' }, to: '/p/$key/tasks' });
    });
    await within(nav).findByRole('link', { name: /^MMR Mimir.*contains this page/ });
    expect(nav.querySelector('details')).not.toHaveAttribute('open');
  });

  it.each(['/p/MMR/tasks', '/p/MMR/seeds', '/p/MMR/artifacts', '/p/MMR/s41', '/p/MMR/99'])(
    'rings the project on %s, which it holds, with its initiatives below',
    async (path) => {
      await renderAt(path);
      const nav = await expectRows([
        '← Home',
        'MMR Mimir 1/5, In progress, contains this page',
        'initiative MMR-1 0/3, In progress',
        'initiative MMR-8 ∞, Ready',
        'initiative MMR-9 parked, Parked',
      ]);
      const project = within(nav).getByRole('link', { name: /^MMR Mimir/ });
      expect(project).not.toHaveAttribute('aria-current');
      expect(project).toHaveAttribute('data-holds', 'true');
      expect(project.className).toContain('data-[holds]:inset-ring-accent');
      await expect(pageMarks()).resolves.toStrictEqual([]);
    },
  );

  it('shows ← Home and a skeleton while the tree loads', async () => {
    vi.mocked(tree).mockReturnValue(Promise.withResolvers<never>().promise);
    await renderAt('/p/MMR');
    const nav = await expectRows(['← Home']);
    expect(nav.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('says so when the tree cannot be read, keeping the project’s key and name', async () => {
    vi.mocked(tree).mockRejectedValue(new Error('down'));
    await renderAt('/p/MMR');
    const nav = await sidebar();
    await expect(
      within(nav).findByText('Couldn’t load the structure.'),
    ).resolves.toBeInTheDocument();
    expect(rowsOf(nav)).toStrictEqual(['← Home', 'MMR Mimir']);
  });

  // Archived in another tab: the refetched tree 404s while the cached one still lists its initiatives.
  it('drops the cached initiatives once a refetched tree is not found', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { refetchInterval: false, retry: false } },
    });
    await renderShell('/p/MMR', client);
    await expectRows([
      '← Home',
      'MMR Mimir 1/5, In progress',
      'initiative MMR-1 0/3, In progress',
      'initiative MMR-8 ∞, Ready',
      'initiative MMR-9 parked, Parked',
    ]);
    vi.mocked(tree).mockRejectedValue(new ApiError('tree MMR → 404', 404));
    await client.invalidateQueries({ queryKey: ['tree', 'MMR'] });
    const nav = await expectRows(['← Home', 'MMR']);
    expect(within(nav).queryByRole('link', { name: /^initiative/ })).toBeNull();
  });
});

describe('sidebar on an initiative (MMR-730)', () => {
  it('leads back to the project and lists the initiative’s phases, Empty where nothing is under one', async () => {
    await renderAt('/p/MMR/1');
    const nav = await expectRows([
      '← Mimir',
      'initiative MMR-1 0/3, In progress',
      'phase MMR-2 0/1, In progress',
      'phase MMR-4 Empty, Ready',
    ]);
    expect(within(nav).getByRole('link', { name: '← Mimir' })).toHaveAttribute('href', '/p/MMR');
    await expect(pageMarks()).resolves.toStrictEqual(['initiative MMR-1 0/3, In progress']);
  });

  it('folds a finished initiative’s phases into “1 finished phase”', async () => {
    await renderAt('/p/MMR/5');
    const nav = await expectRows(['← Mimir', 'initiative MMR-5 1/1, Done']);
    await userEvent.click(within(nav).getByText('1 finished phase'));
    expect(within(nav).getByRole('link', { name: /phase MMR-6/ })).toBeVisible();
  });
});

describe('sidebar on a phase (MMR-730)', () => {
  it('leads back to its initiative and ends at the phase, washed as the page', async () => {
    await renderAt('/p/MMR/2');
    const nav = await expectRows(['← initiative MMR-1', 'phase MMR-2 0/1, In progress']);
    expect(within(nav).getByRole('link', { name: '← initiative MMR-1' })).toHaveAttribute(
      'href',
      '/p/MMR/1',
    );
    await expect(pageMarks()).resolves.toStrictEqual(['phase MMR-2 0/1, In progress']);
    expect(within(nav).queryByText(/finished/)).toBeNull();
  });
});

describe('sidebar on a task (MMR-730)', () => {
  it('under a phase: rings the phase, with no row for the task', async () => {
    await renderAt('/p/MMR/3');
    const nav = await expectRows([
      '← initiative MMR-1',
      'phase MMR-2 0/1, In progress, contains this page',
    ]);
    const phase = within(nav).getByRole('link', { name: /phase MMR-2/ });
    expect(phase).toHaveAccessibleName('phase MMR-2 0/1, In progress, contains this page');
    expect(phase).not.toHaveAttribute('aria-current');
    expect(within(nav).queryByRole('link', { name: /task MMR-3/ })).toBeNull();
    await expect(pageMarks()).resolves.toStrictEqual([]);
  });

  it('directly under an initiative: rings the initiative, with its phases below', async () => {
    await renderAt('/p/MMR/11');
    await expectRows([
      '← Mimir',
      'initiative MMR-1 0/3, In progress, contains this page',
      'phase MMR-2 0/1, In progress',
      'phase MMR-4 Empty, Ready',
    ]);
    await expect(pageMarks()).resolves.toStrictEqual([]);
  });
});

describe('sidebar rows name their status in words, not by the dot alone (MMR-807)', () => {
  it('names the current container’s status, and its children’s', async () => {
    await renderAt('/p/MMR');
    const nav = await sidebar();
    await expect(
      within(nav).findByRole('link', { name: /^MMR Mimir/ }),
    ).resolves.toHaveAccessibleName('MMR Mimir 1/5, In progress');
    expect(within(nav).getByRole('link', { name: /initiative MMR-8/ })).toHaveAccessibleName(
      'initiative MMR-8 ∞, Ready',
    );
    expect(within(nav).getByRole('link', { name: /initiative MMR-9/ })).toHaveAccessibleName(
      'initiative MMR-9 parked, Parked',
    );
  });

  it('names the status before saying the row holds the page', async () => {
    await renderAt('/p/MMR/3');
    const nav = await sidebar();
    await expect(
      within(nav).findByRole('link', { name: /phase MMR-2/ }),
    ).resolves.toHaveAccessibleName('phase MMR-2 0/1, In progress, contains this page');
  });

  it('names a finished row’s status inside the fold', async () => {
    await renderAt('/p/MMR');
    const nav = await sidebar();
    await userEvent.click(await within(nav).findByText('1 finished initiative'));
    expect(within(nav).getByRole('link', { name: /initiative MMR-5/ })).toHaveAccessibleName(
      'initiative MMR-5 1/1, Done',
    );
  });

  it('names each project’s status on Home, after its needs-you count', async () => {
    serveWorld([needsYou('HND', 3)], [dated('BLK', '05', { status: 'blocked' })]);
    await renderAt('/');
    const nav = await sidebar();
    // The needs-you count loads apart from the row, so wait for the whole name.
    await expect(
      within(nav).findByRole('link', { name: 'HND HND title 3 need you, In progress' }),
    ).resolves.toHaveAttribute('href', '/p/HND');
    expect(within(nav).getByRole('link', { name: /^BLK/ })).toHaveAccessibleName(
      'BLK BLK title, Blocked',
    );
  });

  it('gives Home’s row, which has no dot, no status word', async () => {
    serveWorld();
    await renderAt('/');
    // Home's row shows before its tally loads, so wait for the whole name.
    await expect(
      within(await sidebar()).findByRole('link', { name: 'Home, 4 projects' }),
    ).resolves.toHaveAttribute('href', '/');
  });
});

/** The sidebar's Needs you slot, named by its head. */
const slotOf = async (nav: HTMLElement) => within(nav).findByRole('group', { name: /^Needs you/ });

/** The review report holds `rows`, and lists MMR and FLT. */
function serveCards(rows: Row[]) {
  serveViews({ review: report(rows) });
}

/** The slot once the review report has answered. */
async function slot(nav?: HTMLElement) {
  const found = await slotOf(nav ?? (await sidebar()));
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy');
  });
  return found;
}

describe('sidebar’s Needs you (MMR-804)', () => {
  /** MMR's cards in the deck's order: a stopped delivery, a question, a blocked task, and its decisions without a delivery. */
  const MMR_CARDS = [
    stopped('MMR-d4'),
    question('MMR-7'),
    blocked('MMR-3'),
    decision('MMR-q1', { delivery: null }),
  ];

  it('lists three cards under a head counting them all, then See all N to the Work tab', async () => {
    serveCards([question('FLT-2'), ...MMR_CARDS]);
    await renderAt('/p/MMR/1');
    const group = await slot();
    expect(group).toHaveAccessibleName('Needs you 4');
    expect(
      within(group)
        .getAllByRole('link')
        .map((link) => link.textContent.replaceAll(/\s+/g, ' ').trim()),
    ).toStrictEqual([
      'Stopped Delivery MMR-d4',
      'Question Task MMR-7',
      'Blocked Task MMR-3',
      'See all 4',
    ]);
    expect(within(group).getByRole('link', { name: 'See all 4' })).toHaveAttribute(
      'href',
      '/p/MMR',
    );
  });

  it('reads each row as its lead word, then its title, linking where the card opens', async () => {
    serveCards([decision('MMR-q1', { delivery: null }), question('MMR-7'), stopped('MMR-d4')]);
    await renderAt('/p/MMR/1');
    const group = await slot();
    expect(
      within(group).getByRole('link', { name: 'Decisions Mimir decisions without a delivery' }),
    ).toHaveAttribute('href', '/p/MMR');
    expect(within(group).getByRole('link', { name: 'Question Task MMR-7' })).toHaveAttribute(
      'href',
      '/p/MMR/7',
    );
    expect(within(group).getByRole('link', { name: 'Stopped Delivery MMR-d4' })).toHaveAttribute(
      'href',
      '/p/MMR/d4',
    );
  });

  it('shows one card alone, with no See all', async () => {
    serveCards([blocked('MMR-3')]);
    await renderAt('/p/MMR/1');
    const group = await slot();
    expect(group).toHaveAccessibleName('Needs you 1');
    expect(within(group).getAllByRole('link')).toHaveLength(1);
    expect(within(group).queryByText(/See all/)).toBeNull();
  });

  it('says nothing needs you in the project, with no head, when it has no card', async () => {
    serveCards([question('FLT-2')]);
    await renderAt('/p/MMR/1');
    const nav = await sidebar();
    await expect(
      within(nav).findByText('Nothing needs you in Mimir.'),
    ).resolves.toBeInTheDocument();
    expect(within(nav).queryByRole('group', { name: /^Needs you/ })).toBeNull();
    expect(within(nav).queryByText('Needs you')).toBeNull();
  });

  it('shows the head without a count over three skeleton rows while the report loads', async () => {
    vi.mocked(review).mockReturnValue(Promise.withResolvers<never>().promise);
    await renderAt('/p/MMR/1');
    const group = await slotOf(await sidebar());
    expect(group).toHaveAccessibleName('Needs you');
    expect(group).toHaveAttribute('aria-busy', 'true');
    expect(within(group).getAllByTestId('needs-you-skeleton')).toHaveLength(3);
  });

  it('says so under the head when the report cannot be read', async () => {
    vi.mocked(review).mockRejectedValue(new Error('unreachable'));
    await renderAt('/p/MMR/1');
    const group = await slot();
    expect(group).toHaveAccessibleName('Needs you');
    await expect(within(group).findByText('Couldn’t load what needs you.')).resolves.toHaveClass(
      'text-status-blocked-foreground',
    );
  });

  it.each([
    ['Home', '/'],
    ['Settings', '/settings/about'],
  ])('is not on %s', async (_page, path) => {
    serveCards(MMR_CARDS);
    await renderAt(path);
    const nav = await sidebar();
    await waitFor(() => {
      expect(review).toHaveBeenCalled();
    });
    expect(within(nav).queryByRole('group', { name: /^Needs you/ })).toBeNull();
    expect(within(nav).queryByText(/Nothing needs you/)).toBeNull();
  });

  it('is not on a project the report does not list', async () => {
    serveShell({
      projects: [MMR, NRN],
      trees: { MMR: TREE, NRN: node('NRN', 'project', 'ready', [], { title: 'Norn' }) },
    });
    serveCards(MMR_CARDS);
    await renderAt('/p/NRN');
    const nav = await expectRows(['← Home', 'NRN Norn Empty, Ready']);
    await waitFor(() => {
      expect(within(nav).queryByRole('group', { name: /^Needs you/ })).toBeNull();
    });
    expect(within(nav).queryByText(/Nothing needs you/)).toBeNull();
  });

  it('is not on an archived project, even before the report answers', async () => {
    const OLD = engineProject({
      archivedAt: new Date('2026-09-30T15:00:00.000Z'),
      id: 'OLD',
      title: 'Old project',
    });
    serveShell({ archived: [OLD], projects: [MMR], trees: { MMR: TREE } });
    vi.mocked(review).mockReturnValue(Promise.withResolvers<never>().promise);
    await renderAt('/p/OLD');
    const nav = await expectRows(['← Home', 'OLD Old project']);
    expect(within(nav).queryByRole('group', { name: /^Needs you/ })).toBeNull();
  });

  it('on the Work tab, keeps See all and the project’s decisions as plain text', async () => {
    serveCards([decision('MMR-q1', { delivery: null }), ...MMR_CARDS.slice(0, 3)]);
    await renderAt('/p/MMR');
    const group = await slot(await sidebar());
    expect(within(group).getByText('See all 4')).not.toHaveAttribute('href');
    expect(within(group).queryByRole('link', { name: /See all/ })).toBeNull();
    expect(within(group).queryByRole('link', { name: /^Decisions/ })).toBeNull();
    expect(within(group).getByText('Mimir decisions without a delivery')).toBeInTheDocument();
    expect(within(group).getByRole('link', { name: 'Question Task MMR-7' })).toBeInTheDocument();
  });

  it('on the Details tab, leaves See all and the project’s decisions as links', async () => {
    serveCards([decision('MMR-q1', { delivery: null }), ...MMR_CARDS.slice(0, 3)]);
    await renderAt('/p/MMR?tab=details');
    const group = await slot();
    expect(within(group).getByRole('link', { name: 'See all 4' })).toHaveAttribute(
      'href',
      '/p/MMR',
    );
    expect(
      within(group).getByRole('link', { name: 'Decisions Mimir decisions without a delivery' }),
    ).toHaveAttribute('href', '/p/MMR');
  });

  it.each(['/p/MMR/7', '/p/MMR/7?tab=details'])(
    'keeps a task’s row as plain text on its own page (%s)',
    async (path) => {
      serveCards(MMR_CARDS);
      await renderAt(path);
      const group = await slot();
      expect(within(group).queryByRole('link', { name: /Task MMR-7/ })).toBeNull();
      expect(within(group).getByText('Task MMR-7')).toBeInTheDocument();
      expect(within(group).getByRole('link', { name: 'Blocked Task MMR-3' })).toBeInTheDocument();
    },
  );

  it.each(['/p/MMR', '/p/MMR?tab=details', '/p/MMR/7', '/p/MMR/1'])(
    'marks nothing in the slot as current on %s',
    async (path) => {
      serveCards([decision('MMR-q1', { delivery: null }), ...MMR_CARDS]);
      await renderAt(path);
      const group = await slot();
      await waitFor(() => {
        expect(within(group).getAllByText(/See all/)).toHaveLength(1);
      });
      expect(group.querySelectorAll('[aria-current], [data-holds]')).toHaveLength(0);
    },
  );

  it.each(['/p/MMR/d4', '/p/MMR/d4?mode=decisions'])(
    'keeps a delivery’s row as plain text on its own page (%s)',
    async (path) => {
      serveCards(MMR_CARDS);
      await renderAt(path);
      const group = await slot();
      expect(within(group).queryByRole('link', { name: /Delivery MMR-d4/ })).toBeNull();
      expect(within(group).getByText('Delivery MMR-d4')).toBeInTheDocument();
      expect(within(group).getByRole('link', { name: 'Question Task MMR-7' })).toBeInTheDocument();
    },
  );

  it('shows exactly three cards with no See all', async () => {
    serveCards(MMR_CARDS.slice(0, 3));
    await renderAt('/p/MMR/1');
    const group = await slot();
    expect(group).toHaveAccessibleName('Needs you 3');
    expect(within(group).getAllByRole('link')).toHaveLength(3);
    expect(within(group).queryByText(/See all/)).toBeNull();
  });

  it('is not on a project whose tree is missing, even before the report answers', async () => {
    vi.mocked(tree).mockRejectedValue(new ApiError('tree MMR → 404', 404));
    vi.mocked(review).mockReturnValue(Promise.withResolvers<never>().promise);
    await renderAt('/p/MMR');
    const nav = await expectRows(['← Home', 'MMR']);
    expect(within(nav).queryByRole('group', { name: /^Needs you/ })).toBeNull();
  });

  it('is not on a node id in the project segment, even before the report answers', async () => {
    serve([MMR], { 'MMR-5': node('MMR-5', 'initiative', 'done') });
    vi.mocked(review).mockReturnValue(Promise.withResolvers<never>().promise);
    await renderAt('/p/MMR-5');
    const nav = await expectRows(['← Home', 'MMR-5']);
    expect(within(nav).queryByRole('group', { name: /^Needs you/ })).toBeNull();
  });

  it('shows once the report lists the project, though its tree is missing', async () => {
    vi.mocked(tree).mockRejectedValue(new ApiError('tree MMR → 404', 404));
    serveCards([question('MMR-7')]);
    await renderAt('/p/MMR');
    const group = await slot();
    expect(group).toHaveAccessibleName('Needs you 1');
    expect(within(group).getByRole('link', { name: 'Question Task MMR-7' })).toBeInTheDocument();
  });

  it('keeps the rows it has when a later read of the report fails', async () => {
    serveCards([question('MMR-7')]);
    const client = new QueryClient({
      defaultOptions: { queries: { refetchInterval: false, retry: false } },
    });
    await renderShell('/p/MMR/1', client);
    await slot();
    vi.mocked(review).mockRejectedValue(new Error('offline'));
    await act(async () => {
      await client.refetchQueries({ queryKey: reviewQuery().queryKey });
    });
    const group = await slot();
    expect(within(group).getByRole('link', { name: 'Question Task MMR-7' })).toBeInTheDocument();
    expect(within(group).queryByText('Couldn’t load what needs you.')).toBeNull();
  });
});

describe('sidebar on an archived or unavailable project (MMR-730)', () => {
  const OLD = engineProject({
    archivedAt: new Date('2026-09-30T15:00:00.000Z'),
    id: 'OLD',
    status: 'done',
    title: 'Old project',
  });

  /** `OLD` is archived and `GONE` is no project: their records and trees 404. */
  function serveArchived() {
    vi.mocked(projects).mockImplementation(async ({ data }) =>
      data.status === 'archived' ? [OLD] : [MMR],
    );
    const servedTree = vi.mocked(tree).getMockImplementation();
    vi.mocked(tree).mockImplementation(async (options) => {
      if (options.data.id === 'OLD' || options.data.id === 'GONE') {
        throw new ApiError(`tree ${options.data.id} → 404`, 404);
      }
      return servedTree?.(options) as Promise<EngineTree>;
    });
    vi.mocked(getNode).mockRejectedValue(new MimirError('not_found', 'no such project'));
  }

  it('shows ← Home and the archived project’s key and name alone, with no dot, tally, or error', async () => {
    serveArchived();
    await renderAt('/p/OLD');
    const nav = await expectRows(['← Home', 'OLD Old project']);
    const row = within(nav).getByRole('link', { name: /^OLD/ });
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(row.querySelector('[class*="rounded-full"]')).toBeNull();
    expect(within(nav).queryByText('Couldn’t load the structure.')).toBeNull();
  });

  it('rings the archived project’s row, not marking it the page, on a page it holds', async () => {
    serveArchived();
    await renderAt('/p/OLD/s3');
    const nav = await expectRows(['← Home', 'OLD Old project, contains this page']);
    const row = within(nav).getByRole('link', { name: /^OLD/ });
    expect(row).not.toHaveAttribute('aria-current');
    expect(row).toHaveAttribute('data-holds', 'true');
    expect(row).toHaveAccessibleName('OLD Old project, contains this page');
  });

  it('shows ← Home and an unavailable project’s key alone', async () => {
    serveArchived();
    await renderAt('/p/GONE');
    const nav = await expectRows(['← Home', 'GONE']);
    expect(within(nav).queryByText('Couldn’t load the structure.')).toBeNull();
  });
});

describe('one current page per document', () => {
  it.each([
    ['/', /^Home, \d+ project/],
    ['/p/MMR/1', /^initiative MMR-1/],
    ['/settings/about', /^About$/],
  ])('marks only the sidebar’s row as the page on %s', async (path, row) => {
    await renderAt(path);
    const nav = await sidebar();
    await waitFor(() => {
      expect(within(nav).getByRole('link', { name: row })).toHaveAttribute('aria-current', 'page');
    });
    if (path === '/p/MMR/1') {
      await screen.findByRole('navigation', { name: 'Ancestors' });
    }
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });
});

describe('sidebar announces where the page is', () => {
  it('names the sidebar landmark', async () => {
    await renderAt('/p/MMR');
    await sidebar();
    expect(screen.getByRole('complementary', { name: 'Project' })).toBeInTheDocument();
  });

  it('offers a skip link before everything else that moves focus to the page', async () => {
    await renderAt('/p/MMR/2');
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
    await renderAt('/p/MMR/2');
    const open = await screen.findByRole('button', { name: 'Open project menu' });
    expect(screen.queryByRole('complementary', { name: 'Project' })).toBeNull();
    await userEvent.click(open);
    await expect(screen.findByRole('dialog', { name: 'Project' })).resolves.toBeInTheDocument();
  });

  // On a phone the toasts sit at the top (a bottom sheet's footer owns the bottom), under the top bar
  // the shell measures, not over it.
  it('puts the toasts under the top bar on a phone', async () => {
    stubViewport('phone');
    // jsdom lays nothing out, so every other element measures as it would anyway: zero.
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    measured.mockImplementation(function headerRect(this: HTMLElement) {
      return this.tagName === 'HEADER' ? new DOMRect(0, 0, 390, 57) : new DOMRect();
    });
    onTestFinished(() => {
      measured.mockRestore();
    });
    await renderAt('/p/MMR');
    notice('Saved on a phone');
    const region = await waitFor(() => {
      const el = screen.getByText('Saved on a phone').closest('[class*="fixed"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // A phone is below `md` (DESIGN.md), where the Notice moves to the top.
    expect(region).toHaveClass(
      'max-md:top-[calc(var(--layer-top-bar-height,var(--top-bar-height,0px))+0.5rem)]',
    );
    expect(region).not.toHaveClass('max-md:top-4');
    const shell = region.closest<HTMLElement>('[style*="--top-bar-height"]');
    expect(shell?.style.getPropertyValue('--top-bar-height')).toBe('57px');
  });

  it('keeps the desktop toasts at the bottom left', async () => {
    await renderAt('/p/MMR');
    await sidebar();
    notice('Saved on a desktop');
    const region = await waitFor(() => {
      const el = screen.getByText('Saved on a desktop').closest('[class*="fixed"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(region).toHaveClass('bottom-4', 'left-4');
  });

  // DESIGN.md (Toast): 20 above the content area, not on the version footer's hairline.
  it('lifts the desktop toasts 20 above the version footer the shell measures', async () => {
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    measured.mockImplementation(function footerRect(this: HTMLElement) {
      return this.tagName === 'FOOTER' ? new DOMRect(0, 776, 1024, 24) : new DOMRect();
    });
    onTestFinished(() => {
      measured.mockRestore();
    });
    await renderAt('/p/MMR');
    await sidebar();
    notice('Saved above the footer');
    const region = await waitFor(() => {
      const el = screen.getByText('Saved above the footer').closest('[class*="fixed"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(region).toHaveClass('md:bottom-[calc(var(--version-footer-height,0px)+1.25rem)]');
    expect(region).not.toHaveClass('md:bottom-5');
    const shell = region.closest<HTMLElement>('[style*="--version-footer-height"]');
    expect(shell?.style.getPropertyValue('--version-footer-height')).toBe('24px');
  });

  it('moves the Notice toasts clear of the sidebar too', async () => {
    await renderAt('/p/MMR');
    await sidebar();
    notice('Saved by a Notice');
    const region = await waitFor(() => {
      const el = screen
        .getByText('Saved by a Notice')
        .closest('[data-slot], section, div[class*="fixed"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(region.closest('[class*="lg:left-[calc(16rem"]')).not.toBeNull();
  });

  it('leaves the toasts at the edge when there is no sidebar', async () => {
    serve([]);
    await renderAt('/');
    await screen.findByRole('link', { name: 'Mimir' });
    notice('Saved without a sidebar');
    const region = await waitFor(() => {
      const el = screen
        .getByText('Saved without a sidebar')
        .closest('[data-slot], section, div[class*="fixed"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(region.closest('[class*="fixed"]')).not.toBeNull();
    expect(region.closest('[class*="lg:left-[calc(16rem"]')).toBeNull();
  });
});

describe('top bar', () => {
  it('keeps the brand, Needs you, and the More menu, with Jump to in the sidebar (MMR-729)', async () => {
    vi.mocked(review).mockResolvedValue(engineReview({ queue: [{ id: 'MMR-52', kind: 'task' }] }));
    await renderAt('/p/MMR/tasks');
    await sidebar();
    const bar = topBar();
    expect(within(bar).getByRole('link', { name: 'Mimir' })).toHaveAttribute('href', '/');
    expect(within(bar).queryByRole('button', { name: 'Jump to…' })).toBeNull();
    await expect(within(bar).findByRole('link', { name: /need/i })).resolves.toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('holds Settings and the theme switch in More at desktop width (MMR-733)', async () => {
    await renderAt('/p/MMR/tasks');
    await sidebar();
    await userEvent.click(within(topBar()).getByRole('button', { name: 'More' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toStrictEqual(['Settings']);
    const themes = screen.getAllByRole('menuitemradio').map((item) => item.textContent);
    expect(themes).toStrictEqual(['Dark', 'Light']);
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toBeChecked();
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('separator')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    // The theme is a Choice: the menu stays open.
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toBeChecked();
  });

  it('carries no section links or project picker', async () => {
    await renderAt('/p/MMR/tasks');
    await sidebar();
    const bar = topBar();
    for (const name of ['Work', 'Tasks', 'Seeds', 'Artifacts']) {
      expect(within(bar).queryByRole('link', { name })).toBeNull();
    }
    expect(within(bar).queryByRole('button', { name: /MMR/ })).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Open project menu' })).toBeNull();
  });
});

describe('top bar on a phone (MMR-715)', () => {
  beforeEach(() => {
    stubViewport('phone');
  });

  it('keeps the menu, Jump to, and Needs you, and keeps the theme switch in More', async () => {
    vi.mocked(review).mockResolvedValue(engineReview({ queue: [{ id: 'MMR-52', kind: 'task' }] }));
    await renderAt('/p/MMR/tasks');
    await screen.findByRole('button', { name: 'Open project menu' });
    const bar = topBar();
    expect(within(bar).getByRole('button', { name: 'Jump to…' })).toBeInTheDocument();
    await expect(within(bar).findByRole('link', { name: /need/i })).resolves.toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: /theme/i })).toBeNull();

    await userEvent.click(within(bar).getByRole('button', { name: 'More' }));
    // Below md More is a bottom sheet, and the theme is a radio row in it.
    await userEvent.click(await screen.findByRole('radio', { name: 'Light' }));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('dialog', { name: 'More' })).toBeInTheDocument();
  });
});

describe('sidebar drawer on a phone', () => {
  beforeEach(() => {
    stubViewport('phone');
  });

  it('shows no inline sidebar, only a top-bar button that opens it', async () => {
    await renderAt('/p/MMR/tasks');
    const open = await screen.findByRole('button', { name: 'Open project menu' });
    expect(within(topBar()).getByRole('button', { name: 'Open project menu' })).toBe(open);
    expect(screen.queryByRole('navigation', { name: 'Project' })).toBeNull();

    await userEvent.click(open);
    const drawer = await screen.findByRole('dialog', { name: 'Project' });
    const nav = within(drawer).getByRole('navigation', { name: 'Project' });
    await expect(
      within(nav).findByRole('link', { name: /^MMR Mimir.*contains this page/ }),
    ).resolves.toHaveAttribute('data-holds', 'true');
    expect(within(nav).getByRole('button', { name: /MMR.*Mimir/ })).toBeInTheDocument();
  });

  it('closes on Escape and hands focus back to the button', async () => {
    await renderAt('/p/MMR');
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
    await renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project' });
    await waitFor(() => {
      expect(drawer).toContainElement(document.activeElement as HTMLElement);
    });
  });

  it('closes when a container is chosen', async () => {
    const testRouter = await renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project' });

    await userEvent.click(await within(drawer).findByRole('link', { name: /initiative MMR-1/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    });
    expect(testRouter.state.location.pathname).toBe('/p/MMR/1');
  });

  it('draws its rows 44 tall, where the sidebar beside the page draws them 32', async () => {
    await renderAt('/p/MMR/1');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project' });
    const rows = [
      await within(drawer).findByRole('link', { name: '← Mimir' }),
      within(drawer).getByRole('link', { name: /initiative MMR-1/ }),
      within(drawer).getByRole('link', { name: /phase MMR-2/ }),
    ];
    for (const row of rows) {
      expect(row).toHaveClass('min-h-8', 'max-lg:min-h-11');
    }
  });

  it('draws its Needs you rows 44 tall, where the sidebar beside the page draws them 32', async () => {
    serveViews({ review: report([question('MMR-7'), blocked('MMR-3')]) });
    await renderAt('/p/MMR/1');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project' });
    for (const row of [
      await within(drawer).findByRole('link', { name: 'Question Task MMR-7' }),
      within(drawer).getByRole('link', { name: 'Blocked Task MMR-3' }),
    ]) {
      expect(row).toHaveClass('min-h-8', 'max-lg:min-h-11');
    }
  });

  it('clears the phone’s top inset as it does the bottom one', async () => {
    await renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    await expect(screen.findByRole('dialog', { name: 'Project' })).resolves.toHaveClass(
      'pt-[max(0.75rem,env(safe-area-inset-top))]',
      'pb-[max(0.75rem,env(safe-area-inset-bottom))]',
    );
  });

  it('closes behind a Needs you pick that keeps the path, as from the Details tab to the Work tab', async () => {
    serveCards([decision('MMR-q1', { delivery: null }), question('MMR-7')]);
    const testRouter = await renderAt('/p/MMR?tab=details');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project' });

    await userEvent.click(
      await within(drawer).findByRole('link', {
        name: 'Decisions Mimir decisions without a delivery',
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    });
    expect(testRouter.state.location.href).toBe('/p/MMR');
  });

  it("closes behind the Needs you slot's See all from the Details tab, which keeps the path", async () => {
    serveCards([question('MMR-7'), question('MMR-8'), question('MMR-9'), question('MMR-10')]);
    const testRouter = await renderAt('/p/MMR?tab=details');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project' });

    await userEvent.click(await within(drawer).findByRole('link', { name: 'See all 4' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    });
    expect(testRouter.state.location.href).toBe('/p/MMR');
  });

  it('closes when the page changes some other way, such as Back or the jump palette', async () => {
    const testRouter = await renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    await screen.findByRole('dialog', { name: 'Project' });

    await act(async () => {
      await testRouter.navigate({ params: { key: 'MMR', seq: '2' }, to: '/p/$key/$seq' });
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    });
  });

  it('closes when only the query changes, as Back between two tabs of one page', async () => {
    const testRouter = await renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    await screen.findByRole('dialog', { name: 'Project' });

    await act(async () => {
      await testRouter.navigate({
        params: { key: 'MMR' },
        search: { tab: 'details' },
        to: '/p/$key',
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    });
  });

  it("stays open while the page rewrites its own query in place, as a list's search does", async () => {
    const testRouter = await renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    await screen.findByRole('dialog', { name: 'Project' });

    await act(async () => {
      await testRouter.navigate({
        params: { key: 'MMR' },
        replace: true,
        search: { tab: 'details' },
        to: '/p/$key',
      });
    });

    expect(testRouter.state.location.search).toMatchObject({ tab: 'details' });
    expect(screen.getByRole('dialog', { name: 'Project' })).toBeInTheDocument();
  });

  it('closes on the scrim', async () => {
    await renderAt('/p/MMR');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    await screen.findByRole('dialog', { name: 'Project' });

    await userEvent.click(screen.getByTestId('navigation-drawer-scrim'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    });
  });

  it('opens on / with the All projects context: Home and the projects', async () => {
    serve([MMR, NRN], {}, [needsYou('MMR', 1)]);
    await renderAt('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'All projects' });
    const nav = within(drawer).getByRole('navigation', { name: 'All projects' });
    await expect(
      within(nav).findByRole('button', { name: /^All projects.*1 needs you/ }),
    ).resolves.toBeInTheDocument();
    await expect(within(nav).findByRole('link', { name: /^MMR/ })).resolves.toHaveAttribute(
      'href',
      '/p/MMR',
    );
    expect(within(nav).getByRole('link', { name: 'Home, 2 projects' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('has no drawer button with no projects', async () => {
    serve([]);
    await renderAt('/');
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
    await renderAt('/p/MMR');
    await sidebar();
    expect(screen.queryByRole('button', { name: 'Open project menu' })).toBeNull();
  });
});

const settingsNav = () => screen.findByRole('navigation', { name: 'Settings' });

describe('Settings sidebar (MMR-733)', () => {
  const SETTINGS_LINKS = ['Notifications', 'Appearance', 'Devices', 'Connections', 'About'];
  const current = (nav: HTMLElement) =>
    SETTINGS_LINKS.filter(
      (name) =>
        within(nav)
          .getByRole('link', { name: new RegExp(`^${name}`) })
          .getAttribute('aria-current') !== null,
    );

  it('lists the pages under their groups, with a way back to work and no project picker', async () => {
    await renderAt('/settings');
    const nav = await settingsNav();
    expect(screen.getByRole('complementary', { name: 'Settings' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: '← Back to work' })).toHaveAttribute('href', '/');
    expect(within(nav).getByText('This device')).toBeInTheDocument();
    expect(within(nav).getByText('Host')).toBeInTheDocument();
    expect(
      SETTINGS_LINKS.map((name) =>
        within(nav)
          .getByRole('link', { name: new RegExp(`^${name}`) })
          .getAttribute('href'),
      ),
    ).toStrictEqual([
      '/settings/notifications',
      '/settings/appearance',
      '/settings/devices',
      '/settings/connections',
      '/settings/about',
    ]);
    // Jump to is its one button: there is no project picker.
    expect(
      within(nav)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toStrictEqual(['Jump to…']);
    expect(current(nav)).toStrictEqual([]);
  });

  it('marks the open page with the selection treatment', async () => {
    await renderAt('/settings/connections');
    const nav = await settingsNav();
    expect(current(nav)).toStrictEqual(['Connections']);
    const link = within(nav).getByRole('link', { name: 'Connections' });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link.className).toContain('aria-[current=page]:bg-accent/10');
    expect(link.className).toContain('aria-[current=page]:inset-ring-accent');
    expect(link.className).not.toContain('inset-ring-accent/28');
  });

  it('marks Devices as the current section on /pair', async () => {
    await renderAt('/pair');
    const nav = await settingsNav();
    const devices = within(nav).getByRole('link', { name: 'Devices' });
    expect(devices).toHaveAttribute('aria-current', 'true');
    // It holds the page, as a container's row does: the full-strength ring alone.
    expect(devices).toHaveAttribute('data-holds', 'true');
    expect(devices.className).toContain('data-[holds]:inset-ring-accent');
    expect(current(nav)).toStrictEqual(['Devices']);
  });

  it('shows the waiting pairing requests beside Devices', async () => {
    serveDevices({
      pending: [
        {
          created_at: '2026-09-30T15:00:00.000Z',
          device: 'build-box',
          expires_at: '2099-01-01T00:00:00.000Z',
        },
      ],
    });
    await renderAt('/settings/about');
    const nav = await settingsNav();
    const devices = await within(nav).findByRole('link', { name: 'Devices, 1 waiting' });
    expect(within(devices).getByText('1')).toHaveClass('text-attention-foreground');
  });

  it('is the drawer on a phone, with the same content', async () => {
    stubViewport('phone');
    await renderAt('/settings/appearance');
    await userEvent.click(await screen.findByRole('button', { name: 'Open settings menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(drawer).getByRole('link', { name: 'Appearance' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(drawer).getByRole('link', { name: '← Back to work' })).toBeInTheDocument();
  });

  it('frames Settings with no project to frame', async () => {
    serve([]);
    await renderAt('/settings');
    await expect(settingsNav()).resolves.toBeInTheDocument();
  });
});
