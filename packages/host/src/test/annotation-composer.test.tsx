import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, vi } from 'vitest';

import { annotate } from '../api/fns/nodes';
import { AnnotationComposer } from '../components/annotation-composer';
import { engineTask } from './node-fixtures';

vi.mock('../api/fns/nodes');
vi.mock('../components/patterns/notice', () => ({ toast: { error: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe('annotationComposer', () => {
  it('Add note is disabled until non-blank, then sends the trimmed content', async () => {
    vi.mocked(annotate).mockResolvedValue(engineTask({ id: 'MMR-9', status: 'ready' }));
    wrap(<AnnotationComposer nodeId="MMR-9" offline={false} />);
    const btn = screen.getByRole('button', { name: /^add note$/i });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  found a bug  ' } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(annotate).toHaveBeenCalledWith({ data: { content: 'found a bug', id: 'MMR-9' } }),
    );
  });

  it('keeps an unsent note across a remount, as when the Timeline tab closes and reopens', () => {
    const first = wrap(<AnnotationComposer nodeId="MMR-31" offline={false} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'half a thought' } });
    first.unmount();

    wrap(<AnnotationComposer nodeId="MMR-31" offline={false} />);
    expect(screen.getByRole('textbox')).toHaveValue('half a thought');
  });

  it('keeps each record’s draft apart, and forgets it once the note is sent', async () => {
    vi.mocked(annotate).mockResolvedValue(engineTask({ id: 'MMR-32', status: 'ready' }));
    const first = wrap(<AnnotationComposer nodeId="MMR-32" offline={false} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'sent soon' } });
    first.unmount();

    const other = wrap(<AnnotationComposer nodeId="MMR-33" offline={false} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
    other.unmount();

    const again = wrap(<AnnotationComposer nodeId="MMR-32" offline={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^add note$/i }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    again.unmount();

    wrap(<AnnotationComposer nodeId="MMR-32" offline={false} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('is inert when offline: the field itself is disabled, so no note can be composed', () => {
    wrap(<AnnotationComposer nodeId="MMR-9" offline />);
    // The textarea being disabled is the real offline gate — asserting the button
    // alone is a tautology (empty field already disables it regardless of offline).
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: /^add note$/i })).toBeDisabled();
  });
});
