import { QueryClient } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeWork, projectWork, review } from '../api/fns/views';
import { WorkPage } from '../components/work-page';
import { reviewRoute } from '../router';
import { engineProject } from './engine-fixtures';
import { engineContainer } from './node-fixtures';
import { renderInRouter, renderRoute } from './router';
import { engineReview, engineWork, needsYouRow, nowRow, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');

/*
 * The review page and the work pages run on server functions (MMR-538): the
 * review report and the project and container work reads reach the Engine.
 * The work pages render here from a record in hand, as the route does once its
 * record has loaded.
 */

beforeEach(() => {
  serveViews({
    nodes: {
      'MMR-105': engineWork({
        needsYou: [needsYouRow({ id: 'MMR-12', status: 'under_review' }, 'under_review')],
        scope: { id: 'MMR-105', kind: 'phase', title: 'Work page' },
      }),
    },
    projects: {
      MMR: engineWork({ now: [nowRow({ id: 'MMR-11', title: 'Wire the dialect' })] }),
    },
    review: engineReview({
      decisions: [
        {
          project: { key: 'MMR', name: 'Mimir' },
          rows: [needsYouRow({ id: 'MMR-12', status: 'under_review' }, 'under_review')],
        },
      ],
      projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { decisions: 1 })],
      queue: ['MMR-12'],
    }),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const client = () =>
  new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } });

describe('the review and work pages on server functions (MMR-538)', () => {
  it('reads the review page and its rail', async () => {
    await renderRoute([reviewRoute], '/', client());

    await expect(
      screen.findByRole('heading', { level: 1, name: /Needs you/ }),
    ).resolves.toBeInTheDocument();
    expect(review).toHaveBeenCalledWith({ data: { timeZone: expect.any(String) } });
  });

  it('reads a project work page', async () => {
    const record = engineProject({ id: 'MMR', title: 'Mimir' });
    await renderInRouter(<WorkPage record={record} offline={false} />, client());

    await expect(screen.findByRole('region', { name: 'Now · 1' })).resolves.toBeInTheDocument();
    expect(projectWork).toHaveBeenCalledWith({
      data: { project: 'MMR', timeZone: expect.any(String) },
    });
  });

  it('reads a container work page', async () => {
    const record = engineContainer({
      id: 'MMR-105',
      status: 'in_progress',
      title: 'Work page',
      type: 'phase',
    });
    await renderInRouter(
      <WorkPage
        record={record}
        offline={false}
        container={{ onTab: () => {}, tab: 'work', timeline: null, timelineCount: 0 }}
      />,
      client(),
    );

    await expect(
      screen.findByRole('region', { name: 'Needs you · 1' }),
    ).resolves.toBeInTheDocument();
    expect(nodeWork).toHaveBeenCalledWith({
      data: { id: 'MMR-105', timeZone: expect.any(String) },
    });
  });
});
