import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, vi } from 'vitest';

import { update } from '../api/fns/nodes';
import { updateProject } from '../api/fns/shell';
import type { DirectionTarget } from '../api/node-mutations';
import { DirectionDialog } from '../components/direction-line';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../components/patterns/notice', () => ({ toast: { error: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.resetAllMocks();
});

const PROSE = 'Land the console direction line.\n\n- **cut** the dialog\n- wire the PATCH\n';
const MIMIR: DirectionTarget = { key: 'MMR', kind: 'project' };
const CONSOLE: DirectionTarget = { id: 'MMR-12', kind: 'node' };

/** Open the rewrite for `subject`, as More's Edit direction… does; returns its close spy. */
function openRewrite(subject: DirectionTarget, next: string | undefined) {
  const onClose = vi.fn();
  render(
    <DirectionDialog
      subject={subject}
      title="Mimir"
      next={next}
      open
      onClose={onClose}
      finalFocus={() => null}
    />,
    { wrapper },
  );
  return onClose;
}

/** Replace the draft with `text` (or clear it) and Save. */
async function saveAs(text: string) {
  const box = screen.getByRole('textbox', { name: 'Direction text' });
  await userEvent.clear(box);
  if (text !== '') {
    await userEvent.type(box, text);
  }
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
}

describe('directionDialog (MMR-450, MMR-726)', () => {
  it('opens on the current text, and Cancel closes it without a write', async () => {
    const onClose = openRewrite(MIMIR, PROSE);
    expect(screen.getByRole('textbox', { name: 'Direction text' })).toHaveValue(PROSE);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('Save writes the project’s direction with the rewritten text, then closes', async () => {
    const onClose = openRewrite(MIMIR, PROSE);
    await saveAs('Rewritten direction.');

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
    expect(updateProject).toHaveBeenCalledWith({
      data: { id: 'MMR', next: 'Rewritten direction.' },
    });
  });

  it('a node subject writes through the node update', async () => {
    openRewrite(CONSOLE, 'Old plan.');
    await saveAs('New plan.');

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ data: { id: 'MMR-12', next: 'New plan.' } });
    });
  });

  it('saving an emptied project direction clears it with null', async () => {
    openRewrite(MIMIR, PROSE);
    await saveAs('');

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({ data: { id: 'MMR', next: null } });
    });
  });

  it('saving a whitespace-only node direction clears it with null', async () => {
    openRewrite(CONSOLE, 'Old plan.');
    await saveAs('  \n ');

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ data: { id: 'MMR-12', next: null } });
    });
  });

  it('saving a blank direction that was already blank leaves it alone', async () => {
    openRewrite(CONSOLE, undefined);
    await userEvent.type(screen.getByRole('textbox', { name: 'Direction text' }), '  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(update).toHaveBeenCalled();
    });
    expect(vi.mocked(update).mock.calls[0]![0].data.next).toBeUndefined();
  });
});
