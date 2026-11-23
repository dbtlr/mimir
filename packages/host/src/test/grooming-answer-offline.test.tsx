import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import { groom } from '../api/fns/nodes';
import { GroomingAnswerDialog } from '../components/grooming-answer-dialog';

/*
 * The answer dialog while the console is offline (ADR 0019, MMR-721
 * refinement: Offline; ADR 0013 §5): an open dialog keeps its draft, and its
 * Answer commit is `aria-disabled` and does nothing, so nothing queues for
 * reconnect and focus on it survives the drop.
 */

vi.mock('../api/fns/nodes');

afterEach(() => {
  vi.clearAllMocks();
});

const client = new QueryClient();
const dialogAt = (offline: boolean) => (
  <QueryClientProvider client={client}>
    <GroomingAnswerDialog
      nodeId="MMR-1"
      question="Which store?"
      offline={offline}
      onClose={vi.fn()}
    />
  </QueryClientProvider>
);

test('holds the answer while offline, keeps the draft, and sends it once back online', async () => {
  // The answer stays in flight: a send would be seen, and nothing settles it.
  vi.mocked(groom).mockReturnValue(Promise.withResolvers<never>().promise);
  const { rerender } = render(dialogAt(false));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByRole('textbox'), 'SQLite');
  await userEvent.click(within(dialog).getAllByRole('radio')[0]!);
  const commit = within(dialog).getByRole('button', { name: 'Answer' });
  commit.focus();

  rerender(dialogAt(true));
  expect(commit).toHaveAttribute('aria-disabled', 'true');
  expect(commit).toBeEnabled();
  expect(commit).toHaveFocus();
  await userEvent.click(commit);
  await userEvent.keyboard('{Enter}');
  expect(groom).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(within(dialog).getByRole('textbox')).toHaveValue('SQLite');

  rerender(dialogAt(false));
  expect(commit).not.toHaveAttribute('aria-disabled');
  // Coming back online sends nothing by itself: the operator commits again.
  expect(groom).not.toHaveBeenCalled();
  await userEvent.click(commit);
  expect(groom).toHaveBeenCalledOnce();
});
