import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, vi } from 'vitest';

import { DirectionLine, foldDirection } from '../components/direction-line';

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet: vi.fn(), apiSend }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.resetAllMocks();
});

const PROSE = 'Land the console direction line.\n\n- **cut** the dialog\n- wire the PATCH\n';

/** The trigger's accessible name is the microlabel plus the folded line. */
const TRIGGER = { name: /^Direction/ } as const;

function renderProject(next: string | undefined, offline = false) {
  return render(
    <DirectionLine
      subject={{ key: 'MMR', kind: 'project' }}
      title="Mimir"
      next={next}
      offline={offline}
    />,
    { wrapper },
  );
}

describe('foldDirection', () => {
  it('folds to the first line with content, as plain text', () => {
    expect(foldDirection('\n\n  First line.  \nSecond line.')).toBe('First line.');
    expect(foldDirection('## Ship the console\n\nbody')).toBe('Ship the console');
    expect(foldDirection('- **Ship onboarding first.** Then the rest.')).toBe(
      'Ship onboarding first. Then the rest.',
    );
    expect(foldDirection('1. Cut `v0.20.0` from _main_')).toBe('Cut v0.20.0 from main');
    expect(foldDirection('> See [ADR 0026](docs/decisions/0026.md) for the rule')).toBe(
      'See ADR 0026 for the rule',
    );
    expect(foldDirection('Windows wrote this.\r\nAnd this.\r\n')).toBe('Windows wrote this.');
  });

  it('is undefined when there is nothing to fold', () => {
    expect(foldDirection(undefined)).toBeUndefined();
    expect(foldDirection('   \n\n')).toBeUndefined();
  });

  it('leaves snake_case identifiers alone', () => {
    expect(foldDirection('Wire external_ref through the form')).toBe(
      'Wire external_ref through the form',
    );
  });
});

describe('directionLine', () => {
  it('folds multi-line prose to its first line under the Direction microlabel', () => {
    renderProject(PROSE);
    const line = screen.getByRole('button', TRIGGER);
    // jsdom concatenates name parts without layout whitespace; a browser
    // renders the same two boxes as "Direction Land the console…".
    expect(line).toHaveAccessibleName(/^Direction\s*Land the console direction line\.$/);
    // The fold is one line: nothing below the first survives into the row.
    expect(screen.queryByText(/wire the PATCH/)).toBeNull();
  });

  it('reads "No direction set" when the prose is empty', () => {
    renderProject(undefined);
    expect(screen.getByRole('button', TRIGGER)).toHaveAccessibleName(
      /^Direction\s*No direction set$/,
    );
  });

  it('opens a dialog that renders the prose as markdown', async () => {
    const user = userEvent.setup();
    renderProject(PROSE);
    await user.click(screen.getByRole('button', TRIGGER));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('MMR');
    expect(screen.getByText('cut').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('edits the whole text and PATCHes the project, then returns to the reading pane', async () => {
    apiSend.mockResolvedValue({ id: 'MMR' });
    const user = userEvent.setup();
    renderProject(PROSE);
    await user.click(screen.getByRole('button', TRIGGER));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const box = screen.getByRole('textbox');
    expect(box).toHaveValue(PROSE);
    await user.clear(box);
    await user.type(box, 'Rewritten direction.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/MMR', {
        next: 'Rewritten direction.',
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('textbox')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDefined();
  });

  it('a first direction is written from the empty state', async () => {
    apiSend.mockResolvedValue({ id: 'MMR' });
    const user = userEvent.setup();
    renderProject(undefined);
    await user.click(screen.getByRole('button', TRIGGER));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('textbox')).toHaveValue('');
    await user.type(screen.getByRole('textbox'), 'First direction.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/MMR', {
        next: 'First direction.',
      });
    });
  });

  it('cancel discards the draft and writes nothing', async () => {
    const user = userEvent.setup();
    renderProject(PROSE);
    await user.click(screen.getByRole('button', TRIGGER));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.type(screen.getByRole('textbox'), 'scratch');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(apiSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox')).toHaveValue(PROSE);
  });

  it('a new subject under a mounted row drops the open editor and its draft', async () => {
    const user = userEvent.setup();
    const view = renderProject(PROSE);
    await user.click(screen.getByRole('button', TRIGGER));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.type(screen.getByRole('textbox'), 'half-typed rewrite');

    view.rerender(
      <DirectionLine
        subject={{ key: 'SR', kind: 'project' }}
        title="Saga"
        next="Saga's own direction."
        offline={false}
      />,
    );

    // The draft belonged to MMR — it must not follow the row to SR.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', TRIGGER));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox')).toHaveValue("Saga's own direction.");
  });

  it('offline disables Edit', async () => {
    const user = userEvent.setup();
    renderProject(PROSE, true);
    await user.click(screen.getByRole('button', TRIGGER));
    const edit = await screen.findByRole('button', { name: 'Edit' });
    expect(edit).toBeDisabled();
  });

  it('a node subject PATCHes the node route', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-12' });
    const user = userEvent.setup();
    render(
      <DirectionLine
        subject={{ id: 'MMR-12', kind: 'node' }}
        title="Console"
        next="Old plan."
        offline={false}
      />,
      { wrapper },
    );
    await user.click(screen.getByRole('button', TRIGGER));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'New plan.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/nodes/MMR-12', { next: 'New plan.' });
    });
  });
});
