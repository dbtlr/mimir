import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, vi } from 'vitest';

import { AnnotationComposer } from '../components/annotation-composer';

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiSend }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe('annotationComposer', () => {
  it('append is disabled until non-blank, then posts the trimmed content', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    wrap(<AnnotationComposer nodeId="MMR-9" offline={false} />);
    const btn = screen.getByRole('button', { name: /append/i });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  found a bug  ' } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-9/annotations', {
        content: 'found a bug',
      }),
    );
  });

  it('is disabled when offline', () => {
    wrap(<AnnotationComposer nodeId="MMR-9" offline />);
    expect(screen.getByRole('button', { name: /append/i })).toBeDisabled();
  });
});
