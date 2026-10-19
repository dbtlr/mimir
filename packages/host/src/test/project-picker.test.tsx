import type { EngineNode } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { projects, updateProject } from '../api/fns/shell';
import { review } from '../api/fns/views';
import { browserTimeZone } from '../api/queries';
import type { ReviewReport } from '../api/view-queries';
import { ProjectPicker } from '../components/project-picker';
import { routeTree } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { serveBareRecords } from './node-fns';
import { renderInRouter } from './router';
import { failShellReads, serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { engineReview, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

/*
 * The sidebar's project switcher (MMR-497, ADR 0013 refinement): a searchable
 * popover from the header, pinned projects first, then by recent activity,
 * with archived projects folded away. Rendered through the real router so a
 * pick moves the page.
 */

const atDay = (day: string) => new Date(`2026-09-${day}T00:00:00.000Z`);

const NRN = engineProject({ id: 'NRN', lastActivityAt: atDay('05'), pinned: true, title: 'Norn' });
const MMR = engineProject({ id: 'MMR', lastActivityAt: atDay('09'), title: 'Mimir' });
const LUM = engineProject({ id: 'LUM', lastActivityAt: atDay('02'), title: 'Lumen' });
const OLD = engineProject({ archivedAt: atDay('01'), id: 'OLD', title: 'Retired' });

function decisions(key: string, count: number): ReviewReport['projects'][number] {
  return stripRow({ key, name: key }, { decisions: count });
}

type World = {
  projects: EngineNode[];
  archived: EngineNode[];
  review: ReviewReport['projects'];
};

/** The project with its pin set, when it is the one the write names. */
function withPin(p: EngineNode, key: string, pinned: boolean | undefined): EngineNode {
  return p.id === key && pinned !== undefined ? { ...p, pinned } : p;
}

/** Serve a small world; a pin writes into it, as the host would. */
function serve(world: Partial<World> = {}) {
  const { review: decisionRows, ...lists } = {
    archived: [OLD],
    projects: [NRN, MMR, LUM],
    review: [],
    ...world,
  };
  const shell = serveShell(lists);
  serveViews({ review: engineReview({ projects: decisionRows }) });
  vi.mocked(updateProject).mockImplementation(async ({ data }) => {
    shell.projects = shell.projects.map((p) => withPin(p, data.id, data.pinned));
    return engineProject({ id: data.id });
  });
  serveBareRecords();
}

/** The host is unreachable: every read fails. */
function unreachable() {
  vi.mocked(review).mockRejectedValue(new Error('unreachable'));
  failShellReads();
}

/** The pin write the switcher sends for `key`. */
const pinWrite = (key: string, pinned: boolean) => ({ data: { id: key, pinned } });

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } });

function renderAt(initial: string, client = newClient()) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree,
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
const ALL = 'All projects';
const allOption = () => within(listbox()).getByRole('option', { name: /^All projects/ });
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
// The All projects option is no project: it reads as ALL here and stays out of keysInOrder.
const activeKeys = () =>
  within(listbox())
    .getAllByRole('option')
    .filter((o) => o.getAttribute('aria-selected') === 'true')
    .map((o) => projectOf(o) ?? 'ALL');
const keysInOrder = () =>
  within(listbox())
    .queryAllByRole('option')
    .map((o) => projectOf(o))
    .filter((key) => key !== null);

beforeEach(() => {
  serveBrowse();
  serveViews();
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
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{Enter}');
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
      expect(within(optionOf('MMR')).getByLabelText('3 decisions')).toBeInTheDocument();
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
    vi.mocked(projects).mockReturnValue(Promise.withResolvers<EngineNode[]>().promise);
    await renderInRouter(<ProjectPicker context={{ key: 'NRN', kind: 'project' }} />);
    await openSwitcherFromButton();
    await expect(screen.findByText('Loading projects…')).resolves.toBeInTheDocument();
    expect(screen.queryByText(/No project matches/)).toBeNull();
  });

  it('says the list is unavailable when the read fails', async () => {
    unreachable();
    await renderInRouter(
      <ProjectPicker context={{ key: 'NRN', kind: 'project' }} />,
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    await openSwitcherFromButton();
    await expect(screen.findByText('Couldn’t load the projects.')).resolves.toBeInTheDocument();
  });
});

describe('switcher pinning', () => {
  it('pins the highlighted row with Alt+P: write, reorder at once, no navigation', async () => {
    const held = Promise.withResolvers<EngineNode>();
    const testRouter = renderAt('/p/NRN/tasks');
    const search = await openSwitcher();
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Alt+P');
    vi.mocked(updateProject).mockReturnValueOnce(held.promise);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Alt>}p{/Alt}');
    expect(updateProject).toHaveBeenCalledWith(pinWrite('LUM', true));
    await waitFor(() => {
      expect(keysInOrder()).toStrictEqual(['NRN', 'LUM', 'MMR']);
    });
    expect(optionOf('LUM')).toHaveAccessibleName(/LUM.*pinned/);
    expect(optionOf('MMR')).not.toHaveAccessibleName(/pinned/);
    expect(search).toHaveFocus();
    expect(testRouter.state.location.pathname).toBe('/p/NRN/tasks');
    held.resolve(engineProject());
  });

  it('keeps a pending pin when a background poll returns the older list', async () => {
    const held = Promise.withResolvers<EngineNode>();
    const client = newClient();
    renderAt('/p/NRN/tasks', client);
    await openSwitcher();
    vi.mocked(updateProject).mockReturnValueOnce(held.promise);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Alt>}p{/Alt}');
    await waitFor(() => {
      expect(keysInOrder()).toStrictEqual(['NRN', 'LUM', 'MMR']);
    });
    // The server still lists LUM unpinned: the write has not committed.
    await act(() => client.refetchQueries({ queryKey: ['projects'] }));
    expect(keysInOrder()).toStrictEqual(['NRN', 'LUM', 'MMR']);
    expect(optionOf('LUM')).toHaveAccessibleName(/pinned/);
    held.resolve(engineProject());
  });

  it('falls back to the server’s list when the pin fails', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    vi.mocked(updateProject).mockRejectedValueOnce(new Error('read only'));
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
    expect(updateProject).toHaveBeenCalledWith(pinWrite('NRN', false));
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
      expect(updateProject).toHaveBeenCalledWith(pinWrite('MMR', true));
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

describe('switcher All projects option (MMR-505)', () => {
  it('is the first option, above Pinned', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    const options = within(listbox()).getAllByRole('option');
    expect(options[0]).toBe(allOption());
    expect(options[0]).toHaveTextContent(ALL);
    expect(allOption().compareDocumentPosition(optionOf('NRN'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(allOption().closest('[role="group"]')).toBeNull();
  });

  it('carries no pin control and ignores Alt+P', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    expect(allOption().querySelector('[data-pin]')).toBeNull();
    await userEvent.keyboard('{ArrowUp}{Alt>}p{/Alt}');
    expect(activeKeys()).toStrictEqual(['ALL']);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('shows the decisions across every project', async () => {
    serve({ review: [decisions('NRN', 1), decisions('MMR', 3)] });
    renderAt('/p/NRN');
    await openSwitcher();
    await waitFor(() => {
      expect(allOption()).toHaveAccessibleName(/4 decisions/);
    });
  });

  it('is not the current one on a project page', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    expect(allOption()).not.toHaveAttribute('aria-current');
  });

  it.each(['/', '/doctor'])('is the current one on %s', async (path) => {
    renderAt(path);
    await openSwitcher('All');
    expect(allOption()).toHaveAttribute('aria-current', 'true');
    expect(optionOf('NRN')).not.toHaveAttribute('aria-current');
  });

  it('goes to / on a click, keeping the project page behind it', async () => {
    const testRouter = renderAt('/p/NRN/tasks');
    await openSwitcher();
    await userEvent.click(allOption());
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/');
    });
    expect(screen.queryByRole('listbox', { name: 'Projects' })).toBeNull();
  });

  it('goes to / from /doctor, and only closes when already on /', async () => {
    const testRouter = renderAt('/doctor');
    await openSwitcher('All');
    await userEvent.click(allOption());
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/');
    });
    await openSwitcher('All');
    await userEvent.click(allOption());
    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: 'Projects' })).toBeNull();
    });
    expect(testRouter.state.location.pathname).toBe('/');
  });

  it('opens with Enter once highlighted with ArrowUp from the first project', async () => {
    const testRouter = renderAt('/p/NRN/seeds');
    await openSwitcher();
    await userEvent.keyboard('{ArrowUp}{Enter}');
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/');
    });
  });

  it('is reachable by ArrowUp from the first project, and wraps from the last', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    expect(activeKeys()).toStrictEqual(['NRN']);
    await userEvent.keyboard('{ArrowUp}');
    expect(activeKeys()).toStrictEqual(['ALL']);
    await userEvent.keyboard('{ArrowUp}');
    expect(activeKeys()).toStrictEqual(['LUM']);
  });

  it.each([
    ['/p/NRN', 'NRN'],
    ['/p/MMR/tasks', 'MMR'],
    ['/', 'ALL'],
    ['/doctor', 'ALL'],
  ])('opens with the current context highlighted on %s', async (path, expected) => {
    renderAt(path);
    await openSwitcher(path.startsWith('/p/') ? expected : 'All');
    expect(activeKeys()).toStrictEqual([expected]);
  });

  it('does not leave the page on Enter when opened on a project page', async () => {
    const testRouter = renderAt('/p/MMR/tasks');
    await openSwitcher('MMR');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: 'Projects' })).toBeNull();
    });
    expect(testRouter.state.location.pathname).toBe('/p/MMR/tasks');
  });

  it('highlights the first match, not the current project, once a search is typed', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    await userEvent.keyboard('m');
    expect(activeKeys()).toStrictEqual(['MMR']);
  });

  it('starts on the first option when the current project is not listed', async () => {
    renderAt('/p/OLD');
    await openSwitcher('OLD');
    expect(activeKeys()).toStrictEqual(['ALL']);
  });

  it('is hidden while a search is typed, and back when it is cleared', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    await userEvent.keyboard('mmr');
    expect(within(listbox()).queryByRole('option', { name: /^All projects/ })).toBeNull();
    expect(activeKeys()).toStrictEqual(['MMR']);
    await userEvent.keyboard('{Backspace}{Backspace}{Backspace}');
    expect(allOption()).toBeInTheDocument();
  });

  it('is not found by typing "all", since a search is for projects', async () => {
    renderAt('/p/NRN');
    await openSwitcher();
    await userEvent.keyboard('all projects');
    expect(screen.getByText(/No project matches/)).toBeInTheDocument();
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
      expect(review).toHaveBeenCalledWith({ data: { timeZone: browserTimeZone() } });
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
    unreachable();
    await renderInRouter(
      <ProjectPicker context={{ key: 'NRN', kind: 'project' }} />,
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
    await renderInRouter(<ProjectPicker context={{ key: 'NRN', kind: 'project' }} />, client);
    await openSwitcherFromButton();
    await screen.findByRole('option', { name: /MMR/ });
    unreachable();
    await act(() => client.invalidateQueries({ queryKey: ['projects'] }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new project/i })).toBeDisabled();
    });
    await userEvent.keyboard('{Alt>}p{/Alt}');
    await userEvent.click(pinIcon('MMR') as Element);
    expect(updateProject).not.toHaveBeenCalled();
  });
});

describe('switcher header on All projects (MMR-505)', () => {
  it('names All projects with the decisions across every project, and no elsewhere', async () => {
    serve({ review: [decisions('NRN', 1), decisions('MMR', 3)] });
    renderAt('/');
    const button = await screen.findByRole('button', { name: /^All projects.*4 decisions/ });
    expect(button).toHaveTextContent('4');
    expect(button).not.toHaveTextContent('elsewhere');
  });

  it('opens a project from All projects, even the one remembered', async () => {
    const testRouter = renderAt('/');
    await openSwitcher('All');
    await userEvent.click(optionOf('NRN'));
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/NRN');
    });
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
