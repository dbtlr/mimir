import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, vi } from 'vitest';

import { annotate } from '../api/fns/nodes';
import { AnnotationComposer } from '../components/annotation-composer';
import { engineTask } from './node-fixtures';

vi.mock('../api/fns/nodes');
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe('annotationComposer', () => {
  it('append is disabled until non-blank, then sends the trimmed content', async () => {
    vi.mocked(annotate).mockResolvedValue(engineTask({ id: 'MMR-9', status: 'ready' }));
    wrap(<AnnotationComposer nodeId="MMR-9" offline={false} />);
    const btn = screen.getByRole('button', { name: /append/i });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  found a bug  ' } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(annotate).toHaveBeenCalledWith({ data: { content: 'found a bug', id: 'MMR-9' } }),
    );
  });

  it('is inert when offline: the field itself is disabled, so no note can be composed', () => {
    wrap(<AnnotationComposer nodeId="MMR-9" offline />);
    // The textarea being disabled is the real offline gate — asserting the button
    // alone is a tautology (empty field already disables it regardless of offline).
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: /append/i })).toBeDisabled();
  });
});
