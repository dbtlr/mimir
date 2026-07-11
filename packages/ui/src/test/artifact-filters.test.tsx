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
      onChange={(partial) => {
        setFilters((f) => ({ ...f, ...partial }));
      }}
    />
  );
}

describe('artifactFilters', () => {
  it('typing in search debounces a single onChange with the final q', async () => {
    const onChange = vi.fn();
    render(<ArtifactFilters filters={{}} projects={['MMR', 'NOVA']} onChange={onChange} />);
    await userEvent.type(screen.getByPlaceholderText(/search title \+ body/i), 'auth');
    // The box updates immediately…
    expect(screen.getByPlaceholderText(/search title \+ body/i)).toHaveValue('auth');
    // …but onChange only fires once typing pauses (debounced — not per keystroke).
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({ q: 'auth' });
    });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('search box re-syncs when q changes externally (controlled)', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ArtifactFilters filters={{ q: 'auth' }} projects={['MMR']} onChange={onChange} />,
    );
    expect(screen.getByPlaceholderText(/search title \+ body/i)).toHaveValue('auth');
    // e.g. Back/Forward or a clear-filters action changes q from outside.
    rerender(<ArtifactFilters filters={{}} projects={['MMR']} onChange={onChange} />);
    expect(screen.getByPlaceholderText(/search title \+ body/i)).toHaveValue('');
  });

  it('+ filter unfolds the editors; picking a project fires onChange', async () => {
    const onChange = vi.fn();
    render(<ArtifactFilters filters={{}} projects={['MMR', 'NOVA']} onChange={onChange} />);
    // The field editors are folded behind the + filter chip.
    expect(screen.queryByLabelText(/project/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '+ filter' }));
    await userEvent.selectOptions(screen.getByLabelText(/project/i), 'NOVA');
    expect(onChange).toHaveBeenCalledWith({ project: 'NOVA' });
  });

  it('active filters render as removable chips', async () => {
    const onChange = vi.fn();
    render(
      <ArtifactFilters
        filters={{ project: 'MMR', since: '2026-06-01', tag: 'kind:session' }}
        projects={['MMR']}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('button', { name: 'Remove filter kind:session' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Remove filter since 2026-06-01' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter MMR' }));
    expect(onChange).toHaveBeenCalledWith({ project: '' });
  });

  it('removing a chip hands keyboard focus to a neighbor, then + filter — never <body>', async () => {
    render(<Harness initial={{ project: 'MMR', tag: 'kind:session' }} />);

    // Activate the first chip's ✕ — its button unmounts, so focus must hop to
    // the surviving neighbor chip instead of dropping to <body>.
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter MMR' }));
    const neighbor = screen.getByRole('button', { name: 'Remove filter kind:session' });
    expect(neighbor).toHaveFocus();

    // Removing the last chip falls back to the + filter button.
    await userEvent.click(neighbor);
    expect(screen.queryByRole('button', { name: /remove filter/i })).toBeNull();
    expect(screen.getByRole('button', { name: '+ filter' })).toHaveFocus();
  });
});
