import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, vi } from 'vitest';

import type { ArtifactFilters as Filters } from '../api/queries';
import { ArtifactFilters } from '../components/artifact-filters';

/** A stateful parent mirroring the page: merges each partial into the filters. */
function Harness({ initial }: { initial: Filters }) {
  const [filters, setFilters] = useState(initial);
  return (
    <ArtifactFilters
      filters={filters}
      projects={['MMR']}
      rowTags={[]}
      onChange={(partial) => {
        setFilters((f) => ({ ...f, ...partial }));
      }}
    />
  );
}

const search = () => screen.getByRole('searchbox', { name: 'Search artifacts' });

describe('artifactFilters', () => {
  it('typing in search debounces a single onChange with the final q', async () => {
    const onChange = vi.fn();
    render(<ArtifactFilters filters={{}} projects={['MMR']} rowTags={[]} onChange={onChange} />);
    await userEvent.type(search(), 'auth');
    expect(search()).toHaveValue('auth');
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({ q: 'auth' });
    });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('is honest that search reads titles', () => {
    render(<ArtifactFilters filters={{}} projects={[]} rowTags={[]} onChange={vi.fn()} />);
    expect(search()).toHaveAttribute('placeholder', 'Search titles…');
  });

  it('re-syncs the search box when q changes externally', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ArtifactFilters filters={{ q: 'auth' }} projects={[]} rowTags={[]} onChange={onChange} />,
    );
    expect(search()).toHaveValue('auth');
    rerender(<ArtifactFilters filters={{}} projects={[]} rowTags={[]} onChange={onChange} />);
    expect(search()).toHaveValue('');
  });

  it('picking a project sets it; the chip names the choice', async () => {
    const onChange = vi.fn();
    render(
      <ArtifactFilters filters={{}} projects={['MMR', 'NOVA']} rowTags={[]} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /All projects/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'NOVA' }));
    expect(onChange).toHaveBeenCalledWith({ project: 'NOVA' });
  });

  it('picking a kind sets the tag filter to the kind tag', async () => {
    const onChange = vi.fn();
    render(
      <ArtifactFilters
        filters={{}}
        projects={[]}
        rowTags={[['kind:review']]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Any kind/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'review' }));
    expect(onChange).toHaveBeenCalledWith({ tag: 'kind:review' });
  });

  it('a chosen kind reads in the kind chip, not as a removable chip', () => {
    render(
      <ArtifactFilters
        filters={{ tag: 'kind:spec' }}
        projects={[]}
        rowTags={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /spec/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove filter/i })).toBeNull();
  });

  it('dates and a plain tag render as removable chips', async () => {
    const onChange = vi.fn();
    render(
      <ArtifactFilters
        filters={{ atOrAfter: '2026-06-01', tag: 'doctor' }}
        projects={[]}
        rowTags={[]}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('button', { name: 'Remove filter tag doctor' })).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove filter on or after 2026-06-01' }),
    );
    expect(onChange).toHaveBeenCalledWith({ atOrAfter: '' });
  });

  it('removing a chip hands keyboard focus to the search box, never <body>', async () => {
    render(<Harness initial={{ atOrAfter: '2026-06-01' }} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove filter on or after 2026-06-01' }),
    );
    expect(search()).toHaveFocus();
  });
});
