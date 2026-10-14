import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } });

function renderAt(initial: string, client = newClient()) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

/** The header button of the project the page shows. */
const header = (key = 'NRN') => screen.findByRole('button', { name: new RegExp(`^${key}`) });

/** Open the switcher of a picker rendered on its own (no sidebar around it). */
async function openSwitcherFromButton() {
  await userEvent.click(screen.getByRole('button', { name: /NRN/ }));
  return screen.findByRole('combobox', { name: 'Find a project' });
}

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
const pinIcon = (key: string) => optionOf(key).querySelector('[data-pin]');
const archivedList = () => screen.getByRole('listbox', { name: 'Archived projects' });
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

  it('keeps archived projects in a collapsed section, openable but with no pin', async () => {
    const testRouter = renderAt('/p/NRN/tasks');
    await openSwitcher();
    expect(screen.queryByRole('listbox', { name: 'Archived projects' })).toBeNull();
    const disclosure = await screen.findByRole('button', { name: /Archived/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const archived = within(archivedList()).getByRole('option', { name: /OLD/ });
    expect(archived).toHaveTextContent('Retired');
    expect(archived.querySelector('[data-pin]')).toBeNull();
    expect(keysInOrder()).toStrictEqual(['NRN', 'MMR', 'LUM']);
    await userEvent.click(archived);
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/OLD/tasks');
    });
  });

  it('reaches an expanded archived project with the arrow keys', async () => {
    const testRouter = renderAt('/p/NRN');
    await openSwitcher();
    await userEvent.click(await screen.findByRole('button', { name: /Archived/ }));
    await userEvent.keyboard('{ArrowUp}{Enter}');
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/OLD');
    });
  });

  it('names an archived current project in the header, with the snowflake', async () => {
    renderAt('/p/OLD');
    const button = await screen.findByRole('button', { name: /^OLD.*Retired/ });
    expect(button).toHaveTextContent('❄');
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

  it('says so when nothing matches a search', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    await userEvent.keyboard('zzz');
    expect(keysInOrder()).toStrictEqual([]);
    expect(screen.getByText(/No project matches/)).toBeInTheDocument();
  });

  it('does nothing on Enter when nothing matches', async () => {
    const testRouter = renderAt('/p/NRN/tasks');
    await openSwitcher();
    await userEvent.keyboard('zzz{Enter}');
    expect(testRouter.state.location.pathname).toBe('/p/NRN/tasks');
    expect(screen.getByRole('combobox', { name: 'Find a project' })).toBeInTheDocument();
  });

  it('says it is loading, not that nothing matches, before the list arrives', async () => {
    apiGet.mockImplementation((path: string) =>
      path === '/api/projects' ? Promise.withResolvers().promise : Promise.resolve(emptyRead(path)),
    );
    await renderInRouter(<ProjectPicker projectKey="NRN" />);
    await openSwitcherFromButton();
    await expect(screen.findByText('Loading projects…')).resolves.toBeInTheDocument();
    expect(screen.queryByText(/No project matches/)).toBeNull();
  });

  it('says the list is unavailable when the read fails', async () => {
    apiGet.mockRejectedValue(new Error('unreachable'));
    await renderInRouter(
      <ProjectPicker projectKey="NRN" />,
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    await openSwitcherFromButton();
    await expect(screen.findByText('Couldn’t load the projects.')).resolves.toBeInTheDocument();
  });
});

describe('switcher pinning', () => {
  it('pins the highlighted row with Alt+P: PATCH, reorder at once, no navigation', async () => {
    const held = Promise.withResolvers<object>();
    const testRouter = renderAt('/p/NRN/tasks');
    const search = await openSwitcher();
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Alt+P');
    apiSend.mockReturnValueOnce(held.promise);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Alt>}p{/Alt}');
    expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/LUM', { pinned: true });
    await waitFor(() => {
      expect(keysInOrder()).toStrictEqual(['NRN', 'LUM', 'MMR']);
    });
    expect(optionOf('LUM')).toHaveAccessibleName(/LUM.*pinned/);
    expect(optionOf('MMR')).not.toHaveAccessibleName(/pinned/);
    expect(search).toHaveFocus();
    expect(testRouter.state.location.pathname).toBe('/p/NRN/tasks');
    held.resolve({});
  });

  it('keeps a pending pin when a background poll returns the older list', async () => {
    const held = Promise.withResolvers<object>();
    const client = newClient();
    renderAt('/p/NRN/tasks', client);
    await openSwitcher();
    apiSend.mockReturnValueOnce(held.promise);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Alt>}p{/Alt}');
    await waitFor(() => {
      expect(keysInOrder()).toStrictEqual(['NRN', 'LUM', 'MMR']);
    });
    // The server still lists LUM unpinned: the write has not committed.
    await act(() => client.refetchQueries({ queryKey: ['projects'] }));
    expect(keysInOrder()).toStrictEqual(['NRN', 'LUM', 'MMR']);
    expect(optionOf('LUM')).toHaveAccessibleName(/pinned/);
    held.resolve({});
  });

  it('falls back to the server’s list when the pin fails', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    apiSend.mockRejectedValueOnce(new Error('read only'));
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Alt>}p{/Alt}');
    await waitFor(() => {
      expect(keysInOrder()).toStrictEqual(['NRN', 'MMR', 'LUM']);
    });
    expect(optionOf('LUM')).not.toHaveAccessibleName(/pinned/);
  });

  it('unpins a pinned row and announces both changes politely', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    await userEvent.keyboard('{Alt>}p{/Alt}');
    expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/NRN', { pinned: false });
    expect(live).toHaveTextContent('Unpinned NRN');
    await waitFor(() => {
      expect(keysInOrder()).toStrictEqual(['MMR', 'NRN', 'LUM']);
    });
    await userEvent.keyboard('{Alt>}p{/Alt}');
    expect(live).toHaveTextContent('Pinned NRN');
  });

  it('toggles with a click on the pin icon, without navigating', async () => {
    const testRouter = renderAt('/p/NRN/tasks');
    await openSwitcher();
    const icon = pinIcon('MMR');
    expect(icon).not.toBeNull();
    await userEvent.click(icon as Element);
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/MMR', { pinned: true });
    });
    expect(testRouter.state.location.pathname).toBe('/p/NRN/tasks');
    expect(screen.getByRole('combobox', { name: 'Find a project' })).toHaveFocus();
  });

  it('keeps the highlight on its project when a pin reorders the list', async () => {
    const testRouter = renderAt('/p/NRN/tasks');
    await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Alt>}p{/Alt}');
    await waitFor(() => {
      expect(keysInOrder()).toStrictEqual(['NRN', 'LUM', 'MMR']);
    });
    expect(activeKeys()).toStrictEqual(['LUM']);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/LUM/tasks');
    });
  });

  it('puts no focusable control inside an option', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    await userEvent.click(await screen.findByRole('button', { name: /Archived/ }));
    const options = [
      ...within(listbox()).getAllByRole('option'),
      ...within(archivedList()).getAllByRole('option'),
    ];
    for (const option of options) {
      expect(option.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0);
    }
  });

  it('scrolls the highlighted row into view', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    await userEvent.keyboard('{ArrowDown}');
    expect(scroll.mock.contexts.at(-1)).toBe(optionOf('MMR'));
    scroll.mockRestore();
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
    expect(screen.getByText('3 decisions in other projects')).toHaveClass('sr-only');
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
    await openSwitcherFromButton();
    const add = await screen.findByRole('button', { name: /new project/i });
    await waitFor(() => {
      expect(add).toBeDisabled();
    });
  });
});

describe('switcher while offline', () => {
  it('does not pin', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await renderInRouter(<ProjectPicker projectKey="NRN" />, client);
    await openSwitcherFromButton();
    await screen.findByRole('option', { name: /MMR/ });
    apiGet.mockRejectedValue(new Error('unreachable'));
    await act(() => client.invalidateQueries({ queryKey: ['projects'] }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new project/i })).toBeDisabled();
    });
    await userEvent.keyboard('{Alt>}p{/Alt}');
    await userEvent.click(pinIcon('MMR') as Element);
    expect(apiSend).not.toHaveBeenCalled();
  });
});

describe('switcher in the phone drawer', () => {
  it('closes on Escape without closing the drawer', async () => {
    stubViewport('phone');
    renderAt('/p/NRN/tasks');
    await userEvent.click(await screen.findByRole('button', { name: 'Open project menu' }));
    await userEvent.click(await header());
    await screen.findByRole('combobox', { name: 'Find a project' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: 'Projects' })).toBeNull();
    });
    expect(screen.getByRole('dialog', { name: 'Project' })).toBeInTheDocument();
  });

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
