import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { WireNode } from '../api/types';
import { ProjectSettingsButton } from '../components/project-settings-button';

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiSend }));
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  vi.clearAllMocks();
});

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const baseProject: WireNode = {
  created_at: '2024-01-01T00:00:00Z',
  description: 'A handy description',
  id: 'MMR',
  parent: null,
  status: 'in_progress',
  title: 'My Project',
  type: 'project',
  updated_at: '2024-01-01T00:00:00Z',
};

describe('projectSettingsButton', () => {
  it('renders a settings button', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    expect(screen.getByRole('button', { name: /project settings/i })).toBeInTheDocument();
  });

  it('is disabled when offline', () => {
    wrap(<ProjectSettingsButton project={baseProject} offline />);
    expect(screen.getByRole('button', { name: /project settings/i })).toBeDisabled();
  });

  it('clicking opens the sheet with name and description fields prefilled', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    expect(screen.getByLabelText(/name/i)).toHaveValue('My Project');
    expect(screen.getByLabelText(/description/i)).toHaveValue('A handy description');
  });

  it('description field is empty when project has no description', () => {
    const project = { ...baseProject, description: null };
    wrap(<ProjectSettingsButton project={project} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    expect(screen.getByLabelText(/description/i)).toHaveValue('');
  });

  it('save button disabled when name is cleared', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    const nameInput = screen.getByLabelText(/name/i);
    fireEvent.change(nameInput, { target: { value: '' } });
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('submitting calls PATCH /api/projects/:key with title and description', async () => {
    apiSend.mockResolvedValue({ description: 'New desc', id: 'MMR', title: 'Renamed' });
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'New desc' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await vi.waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/MMR', {
        description: 'New desc',
        title: 'Renamed',
      });
    });
  });
});

describe('projectCard description display', () => {
  it('project description appears on the project card when present', async () => {
    // Import ProjectCard here to keep the test co-located with the feature
    const { ProjectCard } = await import('../components/project-card');
    render(<ProjectCard project={baseProject} onOpen={() => {}} />);
    expect(screen.getByText('A handy description')).toBeInTheDocument();
  });

  it('no description slot rendered when description is null', async () => {
    const { ProjectCard } = await import('../components/project-card');
    const project = { ...baseProject, description: null };
    render(<ProjectCard project={project} onOpen={() => {}} />);
    expect(screen.queryByText(/description/i)).toBeNull();
  });
});
