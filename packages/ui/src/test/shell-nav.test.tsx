import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, vi } from 'vitest';

import { rememberProject } from '../lib/current-project';
import { router } from '../router';
import { emptyRead, project } from './fixtures';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend: vi.fn() }));

async function renderAt(initial: string, projects = [project({ id: 'MMR' })]) {
  apiGet.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/api/projects' ? { items: projects, total: projects.length } : emptyRead(path),
    ),
  );
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
  if (projects.length > 0) {
    await screen.findByRole('link', { name: 'Tasks' });
  } else {
    await screen.findByRole('link', { name: 'Mimir' });
  }
}

beforeEach(() => {
  localStorage.clear();
});

/** The top-bar nav links currently marked as the active page. */
const activeLinks = () =>
  ['Tasks', 'Artifacts', 'Seeds'].filter(
    (name) => screen.getByRole('link', { name }).getAttribute('aria-current') === 'page',
  );

describe('shell nav marks the active section (MMR-485)', () => {
  it.each([
    ['/p/MMR/tasks', 'Tasks'],
    ['/p/MMR/artifacts', 'Artifacts'],
    ['/p/MMR/seeds', 'Seeds'],
  ])('%s lights only its own link', async (path, label) => {
    await renderAt(path);
    expect(activeLinks()).toStrictEqual([label]);
  });

  it('keeps Tasks active under search params', async () => {
    await renderAt('/p/MMR/tasks?status=ready');
    expect(activeLinks()).toStrictEqual(['Tasks']);
  });

  it('lights nothing off the three sections', async () => {
    await renderAt('/');
    expect(activeLinks()).toStrictEqual([]);
  });

  it('points the sections at the project in the URL', async () => {
    await renderAt('/p/NRN/seeds', [project({ id: 'MMR' }), project({ id: 'NRN' })]);
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/p/NRN/tasks');
    expect(screen.getByRole('link', { name: 'Artifacts' })).toHaveAttribute(
      'href',
      '/p/NRN/artifacts',
    );
    expect(screen.getByRole('link', { name: 'Seeds' })).toHaveAttribute('href', '/p/NRN/seeds');
  });

  it('points the sections at the remembered project off a project page', async () => {
    rememberProject('NRN');
    await renderAt('/', [project({ id: 'MMR' }), project({ id: 'NRN' })]);
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/p/NRN/tasks');
  });

  it('falls back to the first project when nothing is remembered', async () => {
    await renderAt('/', [project({ id: 'MMR' }), project({ id: 'NRN' })]);
    expect(screen.getByRole('link', { name: 'Seeds' })).toHaveAttribute('href', '/p/MMR/seeds');
  });

  it('offers no sections when there are no projects', async () => {
    await renderAt('/', []);
    expect(screen.queryByRole('link', { name: 'Tasks' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('washes the active link in the accent selection treatment, never solid', async () => {
    await renderAt('/p/MMR/seeds');
    const link = screen.getByRole('link', { name: 'Seeds' });
    expect(link.className).toContain('aria-[current=page]:bg-accent/10');
    expect(link.className).toContain('aria-[current=page]:inset-ring-accent/28');
  });

  it('marks the active section in the mobile overflow menu too', async () => {
    await renderAt('/p/MMR/tasks');
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => [i.textContent, i.getAttribute('aria-current')])).toStrictEqual([
      ['Tasks', 'page'],
      ['Artifacts', null],
      ['Seeds', null],
    ]);
  });
});
