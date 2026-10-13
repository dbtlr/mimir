import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import { router } from '../router';
import { emptyRead } from './fixtures';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend: vi.fn() }));

async function renderAt(initial: string) {
  apiGet.mockImplementation((path: string) => Promise.resolve(emptyRead(path)));
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
  await screen.findByRole('link', { name: 'Tasks' });
}

/** The top-bar nav links currently marked as the active page. */
const activeLinks = () =>
  ['Tasks', 'Artifacts', 'Seeds'].filter(
    (name) => screen.getByRole('link', { name }).getAttribute('aria-current') === 'page',
  );

describe('shell nav marks the active section (MMR-485)', () => {
  it.each([
    ['/tasks', 'Tasks'],
    ['/artifacts', 'Artifacts'],
    ['/seeds', 'Seeds'],
  ])('%s lights only its own link', async (path, label) => {
    await renderAt(path);
    expect(activeLinks()).toStrictEqual([label]);
  });

  it('keeps Tasks active under search params', async () => {
    await renderAt('/tasks?project=MMR&status=ready');
    expect(activeLinks()).toStrictEqual(['Tasks']);
  });

  it('lights nothing off the three sections', async () => {
    await renderAt('/');
    expect(activeLinks()).toStrictEqual([]);
  });

  it('washes the active link in the accent selection treatment, never solid', async () => {
    await renderAt('/seeds');
    const link = screen.getByRole('link', { name: 'Seeds' });
    expect(link.className).toContain('aria-[current=page]:bg-accent/10');
    expect(link.className).toContain('aria-[current=page]:inset-ring-accent/28');
  });

  it('marks the active section in the mobile overflow menu too', async () => {
    await renderAt('/tasks?project=MMR');
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
