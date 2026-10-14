import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { WireNode, WireReviewProject } from '../api/types';
import { ProjectPicker } from '../components/project-picker';
import { router } from '../router';
import { emptyRead, project, reviewReport, task, workReport } from './fixtures';
import { renderInRouter } from './router';
import { stubViewport } from './viewport';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

/*
 * The sidebar's project switcher (MMR-497, ADR 0013 refinement): a searchable
 * popover from the header, pinned projects first, then by recent activity,
 * with archived projects folded away. Rendered through the real router so a
 * pick moves the page.
 */

const atDay = (day: string) => `2026-09-${day}T00:00:00.000Z`;

const NRN = project({ id: 'NRN', last_activity_at: atDay('05'), pinned: true, title: 'Norn' });
const MMR = project({ id: 'MMR', last_activity_at: atDay('09'), title: 'Mimir' });
const LUM = project({ id: 'LUM', last_activity_at: atDay('02'), title: 'Lumen' });
const OLD = project({ archived_at: atDay('01'), id: 'OLD', title: 'Retired' });

function decisions(key: string, count: number): WireReviewProject {
  return { decisions: count, in_flight: 0, key, name: key, triage: 0 };
}

/** The project with its pin set, when it is the one the write names. */
function withPin(p: WireNode, key: string | undefined, pinned: boolean): WireNode {
  return p.id === key ? { ...p, pinned } : p;
}

type World = {
  projects: WireNode[];
  archived: WireNode[];
  review: WireReviewProject[];
};

/** Serve a small world; a PATCH writes the pin into it, as the server would. */
function serve(world: Partial<World> = {}) {
  const state: World = { archived: [OLD], projects: [NRN, MMR, LUM], review: [], ...world };
  apiGet.mockImplementation((path: string) => {
    if (path === '/api/projects') {
      return Promise.resolve({ items: state.projects, total: state.projects.length });
    }
    if (path === '/api/projects?status=archived') {
      return Promise.resolve({ items: state.archived, total: state.archived.length });
    }
    if (path === '/api/review') {
      return Promise.resolve(reviewReport({ projects: state.review }));
    }
    if (path.startsWith('/api/doctor') || /^\/api\/projects\/[A-Z]+$/.test(path)) {
      return Promise.withResolvers().promise;
    }
    const record = /^\/api\/nodes\/([A-Z]+-\d+)(\/work\?.*)?$/.exec(path);
    if (record?.[1] !== undefined) {
      return Promise.resolve(
        record[2] === undefined ? task({ id: record[1], status: 'ready' }) : workReport(),
      );
    }
    const tree = /^\/api\/projects\/([A-Z]+)\/tree$/.exec(path)?.[1];
    if (tree !== undefined) {
      return Promise.resolve({ ...project({ id: tree }), children: [] });
    }
    return Promise.resolve(emptyRead(path));
  });
  apiSend.mockImplementation((_method: string, path: string, body: { pinned: boolean }) => {
    const key = path.split('/').at(-1);
    state.projects = state.projects.map((p) => withPin(p, key, body.pinned));
    return Promise.resolve({});
  });
}

function renderAt(initial: string) {
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

/** The header button of the project the page shows. */
const header = (key = 'NRN') => screen.findByRole('button', { name: new RegExp(`^${key}`) });

async function openSwitcher(key?: string) {
  await userEvent.click(await header(key));
  return screen.findByRole('combobox', { name: 'Find a project' });
}

const projectOf = (option: HTMLElement) => option.getAttribute('data-project');
const listbox = () => screen.getByRole('listbox', { name: 'Projects' });
const optionOf = (key: string) => {
  const found = within(listbox())
    .getAllByRole('option')
    .find((o) => projectOf(o) === key);
  expect(found).toBeDefined();
  return found as HTMLElement;
};
const activeKeys = () =>
  within(listbox())
    .getAllByRole('option')
    .filter((o) => o.getAttribute('aria-selected') === 'true')
    .map((o) => projectOf(o));
const keysInOrder = () =>
  within(listbox())
    .queryAllByRole('option')
    .map((o) => projectOf(o));

beforeEach(() => {
  localStorage.clear();
  stubViewport('desktop');
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('switcher order and groups', () => {
  it('lists the pinned project first, then the rest by most recent activity', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    expect(keysInOrder()).toStrictEqual(['NRN', 'MMR', 'LUM']);
    const pinned = within(listbox()).getByRole('group', { name: 'Pinned' });
    expect(within(pinned).getAllByRole('option')).toHaveLength(1);
    const rest = within(listbox()).getByRole('group', { name: 'Recent' });
    expect(
      within(rest)
        .getAllByRole('option')
        .map((o) => projectOf(o)),
    ).toStrictEqual(['MMR', 'LUM']);
  });

  it('omits the Pinned group when nothing is pinned', async () => {
    serve({ projects: [MMR, LUM] });
    renderAt('/p/MMR');
    await openSwitcher('MMR');
    expect(within(listbox()).queryByRole('group', { name: 'Pinned' })).toBeNull();
  });

  it('keeps archived projects in a collapsed section with no pin toggle', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    expect(within(listbox()).queryByText('Retired')).toBeNull();
    const disclosure = await screen.findByRole('button', { name: /Archived/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const archived = screen.getByText('Retired').closest('li');
    expect(archived).not.toBeNull();
    expect(archived).toHaveTextContent('OLD');
    expect(screen.queryByRole('button', { name: /Pin OLD/ })).toBeNull();
    expect(keysInOrder()).toStrictEqual(['NRN', 'MMR', 'LUM']);
  });

  it('marks the current project and shows a decision count only where there is one', async () => {
    serve({ review: [decisions('NRN', 0), decisions('MMR', 3)] });
    renderAt('/p/NRN');
    await openSwitcher();
    await waitFor(() => {
      expect(screen.getByLabelText('3 decisions')).toBeInTheDocument();
    });
    expect(optionOf('NRN')).toHaveAttribute('aria-current', 'true');
    expect(optionOf('MMR')).not.toHaveAttribute('aria-current');
    expect(within(optionOf('MMR')).getByLabelText('3 decisions')).toHaveTextContent('3');
    expect(within(optionOf('NRN')).queryByLabelText(/decision/)).toBeNull();
    expect(within(optionOf('LUM')).queryByLabelText(/decision/)).toBeNull();
  });
});

describe('switcher search', () => {
  it('focuses the search box on open and filters by key or name', async () => {
    renderAt('/p/NRN');
    const search = await openSwitcher();
    expect(search).toHaveFocus();
    await userEvent.keyboard('lum');
    expect(keysInOrder()).toStrictEqual(['LUM']);
    await userEvent.clear(search);
    await userEvent.keyboard('mimir');
    expect(keysInOrder()).toStrictEqual(['MMR']);
  });

  it('says so when nothing matches', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    await userEvent.keyboard('zzz');
    expect(keysInOrder()).toStrictEqual([]);
    expect(screen.getByText(/No project matches/)).toBeInTheDocument();
  });
});

describe('switcher pin toggle', () => {
  it('pins in place: sends the PATCH, reorders at once, and does not navigate', async () => {
    const held = Promise.withResolvers<object>();
    renderAt('/p/NRN/tasks');
    await openSwitcher();
    apiSend.mockReturnValueOnce(held.promise);
    const pin = within(listbox()).getByRole('button', { name: 'Pin LUM' });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(pin);
    expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/LUM', { pinned: true });
    await waitFor(() => {
      expect(keysInOrder()).toStrictEqual(['NRN', 'LUM', 'MMR']);
    });
    expect(within(listbox()).getByRole('button', { name: 'Unpin LUM' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('combobox', { name: 'Find a project' })).toHaveFocus();
    held.resolve({});
  });

  it('unpins a pinned project', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    await userEvent.click(within(listbox()).getByRole('button', { name: 'Unpin NRN' }));
    expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/NRN', { pinned: false });
    await waitFor(() => {
      expect(keysInOrder()).toStrictEqual(['MMR', 'NRN', 'LUM']);
    });
  });

  it('stays on the current page after a pin', async () => {
    const testRouter = renderAt('/p/NRN/tasks');
    await openSwitcher();
    await userEvent.click(within(listbox()).getByRole('button', { name: 'Pin MMR' }));
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalled();
    });
    expect(testRouter.state.location.pathname).toBe('/p/NRN/tasks');
  });
});

describe('switcher keyboard', () => {
  it('moves the active row with the arrows and switches on Enter, keeping the section', async () => {
    const testRouter = renderAt('/p/NRN/tasks');
    await openSwitcher();
    expect(activeKeys()).toStrictEqual(['NRN']);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(activeKeys()).toStrictEqual(['LUM']);
    await userEvent.keyboard('{ArrowUp}');
    expect(activeKeys()).toStrictEqual(['MMR']);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR/tasks');
    });
    expect(screen.queryByRole('listbox', { name: 'Projects' })).toBeNull();
  });

  it('switches to the first match after typing', async () => {
    const testRouter = renderAt('/p/NRN/seeds');
    await openSwitcher();
    await userEvent.keyboard('lu{Enter}');
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/LUM/seeds');
    });
  });

  it('lands on the new project’s work page from a record page', async () => {
    const testRouter = renderAt('/p/NRN/417');
    await openSwitcher();
    await userEvent.keyboard('mmr{Enter}');
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR');
    });
  });

  it('switches on a click too', async () => {
    const testRouter = renderAt('/p/NRN/artifacts');
    await openSwitcher();
    await userEvent.click(within(listbox()).getByText('Lumen'));
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/LUM/artifacts');
    });
  });

  it('closes on Escape and returns focus to the header button', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: 'Projects' })).toBeNull();
    });
    await expect(header()).resolves.toHaveFocus();
  });
});

describe('switcher header', () => {
  it('counts the decisions waiting in other projects', async () => {
    serve({ review: [decisions('NRN', 4), decisions('MMR', 2), decisions('LUM', 1)] });
    renderAt('/p/NRN');
    await expect(screen.findByText('3 elsewhere')).resolves.toBeInTheDocument();
  });

  it('says nothing about elsewhere when only this project has decisions', async () => {
    serve({ review: [decisions('NRN', 4), decisions('MMR', 0)] });
    renderAt('/p/NRN');
    await header();
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith('/api/review');
    });
    expect(screen.queryByText(/elsewhere/)).toBeNull();
  });
});

describe('switcher New project entry (MMR-230)', () => {
  it('sits at the bottom and opens the create sheet', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    const add = screen.getByRole('button', { name: /new project/i });
    expect(add.compareDocumentPosition(listbox()) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    await userEvent.click(add);
    await expect(screen.findByLabelText(/title/i)).resolves.toBeInTheDocument();
    expect(screen.getByText(/joins the project list on the review page/)).toBeInTheDocument();
  });

  it('is disabled when the projects query errors (offline)', async () => {
    apiGet.mockRejectedValue(new Error('unreachable'));
    await renderInRouter(
      <ProjectPicker projectKey="NRN" />,
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    await userEvent.click(screen.getByRole('button', { name: /NRN/ }));
    const add = await screen.findByRole('button', { name: /new project/i });
    await waitFor(() => {
      expect(add).toBeDisabled();
    });
  });
});

describe('switcher in the phone drawer', () => {
  it('opens inside the drawer and switches project', async () => {
    stubViewport('phone');
    const testRouter = renderAt('/p/NRN/tasks');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    await userEvent.click(await header());
    const search = await screen.findByRole('combobox', { name: 'Find a project' });
    expect(search).toHaveFocus();
    await userEvent.keyboard('mmr{Enter}');
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR/tasks');
    });
  });
});
