import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serveBrowse } from './browse-fns';
import { serveDevices } from './devices-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { serveNodes } from './node-fns';
import { renderShell } from './router';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import type { Viewport } from './viewport';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('../api/fns/devices');
vi.mock('../components/patterns/notice', () => ({
  NoticeHost: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

/*
 * Where Jump to sits in the frame (ADR 0013, MMR-729 refinement): at the top
 * of the sidebar and of the drawer, and in the top bar only where the sidebar
 * is not beside the page. ⌘K or Ctrl K opens the one palette from anywhere.
 */

const JUMP = 'Jump to…';
const PALETTE = 'Jump to a record or action';

function serveWorld(withProject = true) {
  serveShell({
    projects: withProject ? [engineProject({ id: 'MMR', title: 'Mimir' })] : [],
    trees: {
      MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }),
    },
  });
  serveNodes({ nodes: [engineProject({ id: 'MMR', title: 'Mimir' })] });
}

async function renderAt(viewport: Viewport, path: string) {
  stubViewport(viewport);
  await renderShell(
    path,
    new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } }),
  );
  await screen.findByRole('link', { name: 'Mimir' });
}

/** The first control in `region`, in document order. */
const firstControl = (region: HTMLElement) => region.querySelector('a, button, input');

/** The shell's top bar: the first banner, since a record page draws its own header below it. */
const topBar = () => screen.getAllByRole('banner')[0] ?? document.body;

/** The palette's search box, once it has focus. */
async function paletteInput() {
  const input = await screen.findByRole('combobox', { name: PALETTE });
  await waitFor(() => {
    expect(input).toHaveFocus();
  });
  return input;
}

async function closePalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Escape}');
  await waitFor(() => {
    expect(screen.queryByRole('combobox', { name: PALETTE })).toBeNull();
  });
}

beforeEach(() => {
  serveBrowse();
  serveViews();
  serveDevices();
  localStorage.clear();
  serveWorld();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Jump to beside the page (MMR-729)', () => {
  it.each([
    ['a project', '/p/MMR', 'Project'],
    ['All projects', '/', 'All projects'],
    ['Settings', '/settings/devices', 'Settings'],
  ])('leads the sidebar on %s, and leaves the top bar', async (_context, path, landmark) => {
    await renderAt('desktop', path);
    const sidebar = await screen.findByRole('complementary', { name: landmark });
    expect(firstControl(sidebar)).toHaveAccessibleName(JUMP);
    expect(firstControl(sidebar)).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    expect(within(sidebar).getByText('Ctrl K')).toBeInTheDocument();
    expect(within(topBar()).queryByRole('button', { name: JUMP })).toBeNull();
    // The bar is the brand, Needs you, and "…".
    expect(within(topBar()).getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('opens the palette from the sidebar and hands focus back to it on Escape', async () => {
    const user = userEvent.setup();
    await renderAt('desktop', '/p/MMR');
    const sidebar = await screen.findByRole('complementary', { name: 'Project' });
    const jump = within(sidebar).getByRole('button', { name: JUMP });

    await user.click(jump);
    await paletteInput();
    await closePalette(user);

    await waitFor(() => {
      expect(jump).toHaveFocus();
    });
  });

  it('opens with Ctrl K from the page, and returns focus to the sidebar when nothing had it', async () => {
    const user = userEvent.setup();
    await renderAt('desktop', '/p/MMR');
    const sidebar = await screen.findByRole('complementary', { name: 'Project' });

    await user.keyboard('{Control>}k{/Control}');
    await paletteInput();
    await closePalette(user);

    await waitFor(() => {
      expect(within(sidebar).getByRole('button', { name: JUMP })).toHaveFocus();
    });
  });

  it('stays in the top bar on a page with no sidebar', async () => {
    serveWorld(false);
    await renderAt('desktop', '/');
    expect(screen.queryByRole('complementary')).toBeNull();
    await expect(
      within(topBar()).findByRole('button', { name: JUMP }),
    ).resolves.toBeInTheDocument();
  });
});

describe('Jump to where the sidebar is a drawer (MMR-729)', () => {
  it.each(['phone', 'tablet'] as const)('keeps the top bar’s Jump to on a %s', async (viewport) => {
    await renderAt(viewport, '/p/MMR');
    await expect(
      within(topBar()).findByRole('button', { name: JUMP }),
    ).resolves.toBeInTheDocument();
  });

  it('leads the drawer, with no shortcut drawn', async () => {
    const user = userEvent.setup();
    await renderAt('tablet', '/p/MMR');
    await user.click(screen.getByRole('button', { name: 'Open project menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project' });
    expect(firstControl(drawer)).toHaveAccessibleName(JUMP);
    expect(within(drawer).queryByText('Ctrl K')).toBeNull();
  });

  it('closes the drawer, opens the palette, and returns focus to the menu button', async () => {
    const user = userEvent.setup();
    await renderAt('phone', '/p/MMR');
    const menu = screen.getByRole('button', { name: 'Open project menu' });
    await user.click(menu);
    const drawer = await screen.findByRole('dialog', { name: 'Project' });

    await user.click(within(drawer).getByRole('button', { name: JUMP }));
    await paletteInput();
    expect(screen.queryByRole('dialog', { name: 'Project' })).toBeNull();
    await closePalette(user);

    await waitFor(() => {
      expect(menu).toHaveFocus();
    });
  });
});
