import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, vi } from 'vitest';

import { ProjectPicker } from '../components/project-picker';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => ({}),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function renderPicker() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProjectPicker />
    </QueryClientProvider>,
  );
}

describe('projectPicker "+ New project" row (MMR-230)', () => {
  it('renders the trailing row after the project rows', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [{ distribution: {}, id: 'MMR', status: 'in_progress', title: 'Mimir' }],
          total: 1,
        });
      }
      return Promise.resolve({ items: [], total: 0 }); // ready
    });
    renderPicker();

    await userEvent.click(screen.getByRole('button', { name: /projects/i }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.at(-1)).toHaveTextContent('+ New project');
    expect(screen.getByRole('menuitem', { name: /MMR.*Mimir/ })).toBeInTheDocument();
  });

  it('clicking the row opens the create sheet', async () => {
    apiGet.mockResolvedValue({ items: [], total: 0 });
    renderPicker();

    await userEvent.click(screen.getByRole('button', { name: /projects/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /new project/i }));
    await expect(screen.findByLabelText(/title/i)).resolves.toBeInTheDocument();
    expect(screen.getByText(/lands in At rest until work starts moving/)).toBeInTheDocument();
  });

  it('the row disables when the projects query errors (offline)', async () => {
    apiGet.mockRejectedValue(new Error('unreachable'));
    renderPicker();

    await userEvent.click(screen.getByRole('button', { name: /projects/i }));
    const row = await screen.findByRole('menuitem', { name: /new project/i });
    await waitFor(() => {
      expect(row).toHaveAttribute('aria-disabled', 'true');
    });
  });
});
