import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { TagEditor } from '../components/tag-editor';

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiSend }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe('tagEditor', () => {
  it('× untags immediately', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    wrap(
      <TagEditor
        nodeId="MMR-9"
        tags={[{ tag: 'ui', note: null, created_at: '' }]}
        offline={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove ui/i }));
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('DELETE', '/api/nodes/MMR-9/tags/ui', undefined),
    );
  });

  it('+ tags the trimmed input', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    wrap(<TagEditor nodeId="MMR-9" tags={[]} offline={false} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' feat ' } });
    fireEvent.click(screen.getByRole('button', { name: /add tag/i }));
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('PUT', '/api/nodes/MMR-9/tags/feat', undefined),
    );
  });

  it('hides controls when offline', () => {
    wrap(<TagEditor nodeId="MMR-9" tags={[{ tag: 'ui', note: null, created_at: '' }]} offline />);
    expect(screen.queryByRole('button', { name: /remove ui/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
