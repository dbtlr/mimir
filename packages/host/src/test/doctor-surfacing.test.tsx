import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { doctor } from '../api/fns/browse';
import type { RecordHealth } from '../api/fns/browse';
import { projectRoute } from '../router';
import { recordHealth } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { serveNodes } from './node-fns';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

beforeEach(() => {
  serveViews();
});

/** A facet with `n` findings on project MMR — surfacing only needs the count. */
function facet(n: number): RecordHealth {
  return recordHealth({
    finding_total: n,
    groups: n === 0 ? [] : [{ finding_count: n, project: 'MMR', records: [] }],
  });
}

describe('record-health surfacing (MMR-185, MMR-727)', () => {
  it('counts the findings among the Work tab’s spare-minute rows, linking to the panel', async () => {
    serveShell({
      projects: [engineProject({ id: 'MMR', title: 'Mimir' })],
      trees: {
        MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }),
      },
    });
    serveNodes({
      nodes: [engineProject({ distribution: { ready: 1 }, id: 'MMR', title: 'Mimir' })],
    });
    serveBrowse({ health: facet(2) });
    await renderRoute([projectRoute], '/p/MMR');

    const row = await screen.findByRole('link', { name: 'Record health findings 2' });
    expect(row).toHaveAttribute('href', '/doctor?project=MMR');
    expect(doctor).toHaveBeenCalledWith({ data: { project: 'MMR' } });
  });
});
