import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projects } from '../api/fns/shell';
import { review } from '../api/fns/views';
import type { ReviewReport } from '../api/view-queries';
import { projectsRoute } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { engineReview, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

/*
 * The Projects list at `/projects` (ADR 0013 and ADR 0019, MMR-790
 * refinements): every active project as a row of counts, need you first, the
 * archived ones folded after them, and New project beside the title. The
 * order and the words are swept in project-list.test.ts and the row options
 * in feed-blocks.test.tsx; this proves the page puts them together.
 */

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('../components/patterns/notice', () => ({
  NoticeHost: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
  serveBrowse();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Four active projects: two that need you (one with nothing live), one busy, one quiet. */
const ACTIVE: ReviewReport['projects'] = [
  stripRow({ key: 'MDG', name: 'Modgud' }),
  stripRow({ key: 'NORN', name: 'Norn' }, { goingCold: 5, inFlight: 2, live: 36, triage: 2 }),
  stripRow({ key: 'FRESH', name: 'Fresh start' }, { needsYou: 1 }),
  stripRow({ key: 'HUGI', name: 'Hugi' }, { inFlight: 3, live: 18, needsYou: 2, triage: 1 }),
];

const ARCHIVED = [
  engineProject({ archivedAt: new Date('2026-10-01T00:00:00.000Z'), id: 'SKL', title: 'Skald' }),
  engineProject({
    archivedAt: new Date('2026-10-02T00:00:00.000Z'),
    id: 'GJL',
    title: 'Gjallarhorn',
  }),
];

function serve({
  active = ACTIVE,
  archived = ARCHIVED,
}: { active?: ReviewReport['projects']; archived?: typeof ARCHIVED } = {}) {
  serveShell({ archived });
  serveViews({ review: engineReview({ projects: active }) });
}

/** The archived read fails; the active read still answers. */
function failArchivedRead() {
  const answer = vi.mocked(projects).getMockImplementation();
  vi.mocked(projects).mockImplementation(async (args) => {
    if (args.data.status === 'archived') {
      throw new Error('unreachable');
    }
    return answer!(args);
  });
}

const quietClient = () =>
  new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } });

const openPage = async () => renderRoute([projectsRoute], '/projects', quietClient());

const countLine = () => document.querySelector('[data-slot="list-count"]');
const activeList = () => screen.getByRole('list', { name: 'Active projects' });
const activeRows = () => within(activeList()).getAllByRole('link');

describe('the Projects list (MMR-790)', () => {
  it('heads the page with its title, the count, and New project', async () => {
    serve();
    await openPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    await waitFor(() => {
      expect(countLine()).toHaveTextContent('4 projects');
    });
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
  });

  it('lists the projects that need you first, then the most live, then by name, each opening its page', async () => {
    serve();
    await openPage();
    await screen.findByRole('list', { name: 'Active projects' });
    expect(activeRows().map((row) => row.getAttribute('href'))).toStrictEqual([
      '/p/HUGI',
      '/p/FRESH',
      '/p/NORN',
      '/p/MDG',
    ]);
  });

  it('gives each phone row one count: the need-you pill, else how much is live', async () => {
    serve();
    await openPage();
    const [hugi, fresh, norn, mdg] = (
      await screen.findByRole('list', { name: 'Active projects' })
    ).querySelectorAll('a');
    expect(within(hugi!).getByText('2 need you')).toHaveAttribute('data-slot', 'row-attention');
    expect(within(fresh!).getByText('1 needs you')).toBeInTheDocument();
    expect(within(norn!).getByText('36 live')).toBeInTheDocument();
    expect(within(mdg!).getByText('Nothing live')).toBeInTheDocument();
    // Nothing live sets the name back, but a project that needs you keeps its ink.
    expect(within(mdg!).getByText('Modgud')).toHaveClass('text-ink-dim');
    expect(within(fresh!).getByText('Fresh start')).toHaveClass('text-ink');
  });

  it('lays out five counts under captions for desktop, a zero an en dash', async () => {
    serve();
    await openPage();
    await screen.findByRole('list', { name: 'Active projects' });
    expect(document.querySelector('[data-slot="row-group-captions"]')).toHaveTextContent(
      'KeyProjectNeed youTo triageIn flightLiveGoing cold',
    );
    const [hugi] = activeRows();
    const figures = [...hugi!.querySelectorAll('[data-slot="row-figure"]')].map(
      (figure) => figure.textContent,
    );
    expect(figures).toStrictEqual([
      '2, 2 need you',
      '1, 1 to triage',
      '3, 3 in flight',
      '18, 18 live',
      '–, 0 going cold',
    ]);
  });

  it('folds the archived projects after the list, closed, each row its key and name opening its page', async () => {
    serve();
    const user = userEvent.setup();
    await openPage();
    const fold = await screen.findByRole('button', { name: 'Archived 2' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Skald')).toBeNull();
    await user.click(fold);
    const archived = screen.getByRole('list', { name: 'Archived projects' });
    const links = within(archived).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toStrictEqual([
      ['GJL Gjallarhorn', '/p/GJL'],
      ['SKL Skald', '/p/SKL'],
    ]);
    expect(within(archived).getByText('Skald')).toHaveClass('text-ink-dim');
  });

  it('has no Archived fold when nothing is archived', async () => {
    serve({ archived: [] });
    await openPage();
    await screen.findByRole('list', { name: 'Active projects' });
    expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
  });

  it('opens the New project sheet', async () => {
    serve();
    const user = userEvent.setup();
    await openPage();
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await expect(screen.findByRole('dialog')).resolves.toBeInTheDocument();
  });

  it('says so quietly on an empty board, and keeps New project', async () => {
    serve({ active: [], archived: [] });
    await openPage();
    await expect(screen.findByText('No projects yet.')).resolves.toBeInTheDocument();
    expect(countLine()).toHaveTextContent('No projects');
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
  });

  it('reads No projects but keeps the fold when every project is archived', async () => {
    serve({ active: [] });
    await openPage();
    await expect(screen.findByRole('button', { name: 'Archived 2' })).resolves.toBeInTheDocument();
    expect(countLine()).toHaveTextContent('No projects');
    expect(screen.queryByText('No projects yet.')).toBeNull();
  });

  it('says the host is unreachable when the review read fails, and holds New project back', async () => {
    serve();
    vi.mocked(review).mockRejectedValue(new Error('unreachable'));
    await openPage();
    await expect(
      screen.findByText('Unreachable — is the Mimir host running?'),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Active projects' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New project' })).toBeDisabled();
  });

  it('says the host is unreachable under the list when the archived read fails', async () => {
    serve();
    failArchivedRead();
    await openPage();
    await expect(
      screen.findByText('Unreachable — is the Mimir host running?'),
    ).resolves.toBeInTheDocument();
    expect(activeRows()).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
  });

  it('says the host is unreachable, not that there are no projects, when only the archived read fails', async () => {
    serve({ active: [] });
    failArchivedRead();
    await openPage();
    await expect(
      screen.findByText('Unreachable — is the Mimir host running?'),
    ).resolves.toBeInTheDocument();
    expect(countLine()).toHaveTextContent('No projects');
    expect(screen.queryByText('No projects yet.')).toBeNull();
  });

  it('keeps the count line while the read is on its way', async () => {
    serve();
    vi.mocked(review).mockReturnValue(Promise.withResolvers<ReviewReport>().promise);
    await openPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    expect(countLine()).toBeInTheDocument();
    expect(countLine()).toHaveTextContent('');
  });
});
