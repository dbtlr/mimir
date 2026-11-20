import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecordPalette, RecordPicker } from '../components/patterns/record-picker';
import type { PaletteGroup, PickerRecord } from '../components/patterns/record-picker';
import { ActionButton } from '../components/ui/action-button';
import { stubViewport } from './viewport';

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROJECTS: PickerRecord[] = [
  { id: 'MMR', title: 'Mimir' },
  { id: 'NRN', title: 'Norn' },
  { id: 'MUN', title: 'Muninn' },
];

const ignore = () => undefined;

function PickerHarness({ onChange = ignore }: { onChange?: (id: string) => void }) {
  const [value, setValue] = useState<string | null>('MMR');
  return (
    <RecordPicker
      label="Project"
      records={PROJECTS}
      value={value}
      placeholder="Choose a project…"
      searchLabel="Find a project"
      emptyText="No projects match."
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('Record picker', () => {
  it('shows the chosen record as its key and title, named by its label and that value', () => {
    render(<PickerHarness />);
    // A screen reader hears the choice with the label, and that the button opens a list.
    const trigger = screen.getByRole('button', { name: 'Project MMR — Mimir' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveTextContent('MMR — Mimir');
    // The key is an identifier, so it is mono; the title is a name, so it is not.
    expect(within(trigger).getByText('MMR')).toHaveClass('font-mono');
  });

  it('opens on a search box that narrows the records by key or title', async () => {
    const user = userEvent.setup();
    render(<PickerHarness />);
    await user.click(screen.getByRole('button', { name: /^Project / }));
    const search = await screen.findByRole('combobox', { name: 'Find a project' });
    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.type(search, 'nor');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['NRNNorn']);
    await user.clear(search);
    await user.type(search, 'mun');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'MUNMuninn',
    ]);
  });

  it('picks with the arrow keys and Enter, and closes back on its trigger', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PickerHarness onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /^Project / });
    await user.click(trigger);
    const search = await screen.findByRole('combobox', { name: 'Find a project' });
    await user.type(search, 'n');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: 'Find a project' })).toBeNull();
    });
    expect(trigger).toHaveTextContent(`${onChange.mock.calls[0]?.[0] as string} — `);
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('says so when no record matches, and picks nothing on Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PickerHarness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /^Project / }));
    const search = await screen.findByRole('combobox', { name: 'Find a project' });
    await user.type(search, 'zzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No projects match.')).toBeVisible();
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens again on an empty search that offers every record', async () => {
    const user = userEvent.setup();
    render(<PickerHarness />);
    await user.click(screen.getByRole('button', { name: /^Project / }));
    await user.type(await screen.findByRole('combobox', { name: 'Find a project' }), 'nor');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: 'Find a project' })).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: /^Project / }));
    await expect(screen.findByRole('combobox', { name: 'Find a project' })).resolves.toHaveValue(
      '',
    );
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('reads as its empty option until a record is chosen', () => {
    render(
      <RecordPicker
        label="Project"
        records={PROJECTS}
        value={null}
        placeholder="Choose a project…"
        searchLabel="Find a project"
        emptyText="No projects match."
        onValueChange={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Project Choose a project…' })).toHaveTextContent(
      'Choose a project…',
    );
  });
});

/** A palette over two groups; `waiting` says the rows answer an older query. */
function PaletteHarness({
  run,
  waiting = false,
  groups,
}: {
  run: (key: string, newTab: boolean) => void;
  waiting?: boolean;
  groups?: PaletteGroup[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const shown: PaletteGroup[] = groups ?? [
    {
      choices: ['MMR-1', 'MMR-2'].map((key) => ({
        content: key,
        key,
        run: (newTab: boolean) => run(key, newTab),
      })),
      label: 'Recent',
    },
    {
      choices: [
        { content: 'File a seed', key: 'seed', run: (newTab: boolean) => run('seed', newTab) },
      ],
      label: 'Actions',
    },
  ];
  return (
    <>
      <ActionButton onClick={() => setOpen(true)}>Jump</ActionButton>
      <RecordPalette
        open={open}
        onClose={() => setOpen(false)}
        label="Jump to a record or action"
        query={query}
        onQueryChange={setQuery}
        groups={query === 'none' ? [] : shown}
        waiting={waiting}
        notice={query === 'none' ? 'No records match “none”.' : undefined}
        hints={[
          { action: 'move', keys: ['up', 'down'] },
          { action: 'open', keys: ['enter'] },
        ]}
      />
    </>
  );
}

/** One group of record rows with these keys. */
const rows = (keys: string[]): PaletteGroup[] => [
  {
    choices: keys.map((key) => ({ content: key, key, run: () => undefined })),
    label: 'Records',
  },
];
/** A palette whose caller searches: the rows for a query arrive as `groups`, after it. */
function Searching({ groups }: { groups: PaletteGroup[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  return (
    <>
      <ActionButton onClick={() => setOpen(true)}>Jump</ActionButton>
      <RecordPalette
        open={open}
        onClose={() => setOpen(false)}
        label="Jump to a record or action"
        query={query}
        onQueryChange={setQuery}
        groups={groups}
      />
    </>
  );
}

async function openPalette() {
  await userEvent.click(screen.getByRole('button', { name: 'Jump' }));
  return screen.findByRole('dialog', { name: 'Jump to a record or action' });
}

describe('Record palette (the jump palette’s Dialog)', () => {
  it('opens on its search box with the first row highlighted', async () => {
    stubViewport('desktop');
    render(<PaletteHarness run={() => undefined} />);
    const dialog = await openPalette();
    const search = within(dialog).getByRole('combobox', { name: 'Jump to a record or action' });
    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    expect(within(dialog).getByRole('option', { name: 'MMR-1' })).toHaveAttribute(
      'data-highlighted',
    );
    expect(within(dialog).getByRole('group', { name: 'Recent' })).toBeInTheDocument();
  });

  it('moves through the groups with the arrow keys and runs the row on Enter', async () => {
    stubViewport('desktop');
    const run = vi.fn();
    render(<PaletteHarness run={run} />);
    await openPalette();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(run).toHaveBeenCalledWith('seed', false);
  });

  it('runs a row in a new tab on Ctrl or ⌘ Enter', async () => {
    stubViewport('desktop');
    const run = vi.fn();
    render(<PaletteHarness run={run} />);
    await openPalette();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(run).toHaveBeenCalledWith('MMR-1', true);
  });

  it('holds Enter while the rows answer an older query, and ignores a click on one', async () => {
    stubViewport('desktop');
    const run = vi.fn();
    const { rerender } = render(<PaletteHarness run={run} waiting />);
    const dialog = await openPalette();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(within(dialog).getByRole('option', { name: 'MMR-2' }));
    expect(run).not.toHaveBeenCalled();
    act(() => {
      rerender(<PaletteHarness run={run} />);
    });
    await waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
    });
  });

  it('holds a Ctrl or ⌘ Enter for the fresh rows, and opens them in a new tab', async () => {
    stubViewport('desktop');
    const run = vi.fn();
    const { rerender } = render(<PaletteHarness run={run} waiting />);
    await openPalette();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(run).not.toHaveBeenCalled();
    act(() => {
      rerender(<PaletteHarness run={run} />);
    });
    await waitFor(() => {
      expect(run).toHaveBeenCalledWith('MMR-1', true);
    });
  });

  it('drops a held Enter when the query changes again before the rows arrive', async () => {
    stubViewport('desktop');
    const run = vi.fn();
    const { rerender } = render(<PaletteHarness run={run} waiting />);
    const dialog = await openPalette();
    await userEvent.keyboard('{Enter}');
    await userEvent.type(
      within(dialog).getByRole('combobox', { name: 'Jump to a record or action' }),
      'm',
    );
    act(() => {
      rerender(<PaletteHarness run={run} />);
    });
    // The Enter belonged to the query it was pressed on; the new query's rows open nothing.
    await act(async () => {
      await Promise.resolve();
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('holds no Enter that commits an IME composition', async () => {
    stubViewport('desktop');
    const run = vi.fn();
    const { rerender } = render(<PaletteHarness run={run} waiting />);
    const dialog = await openPalette();
    fireEvent.keyDown(
      within(dialog).getByRole('combobox', { name: 'Jump to a record or action' }),
      { isComposing: true, key: 'Enter' },
    );
    act(() => {
      rerender(<PaletteHarness run={run} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('highlights the fresh rows’ first once they arrive for a new query, not a row it held', async () => {
    stubViewport('desktop');
    // The caller searches: rows for a new query arrive after it, where the row the highlight held
    // (MMR-2) and the old first row (MMR-1) both stay, neither of them first.
    const { rerender } = render(<Searching groups={rows(['MMR-1', 'MMR-2', 'MMR-3'])} />);
    const dialog = await openPalette();
    await userEvent.keyboard('{ArrowDown}');
    expect(within(dialog).getByRole('option', { name: 'MMR-2' })).toHaveAttribute(
      'data-highlighted',
    );
    await userEvent.type(
      within(dialog).getByRole('combobox', { name: 'Jump to a record or action' }),
      'm',
    );
    act(() => {
      rerender(<Searching groups={rows(['MMR-3', 'MMR-1', 'MMR-2'])} />);
    });
    expect(within(dialog).getByRole('option', { name: 'MMR-3' })).toHaveAttribute(
      'data-highlighted',
    );
    // The arrows still move it from there.
    await userEvent.keyboard('{ArrowDown}');
    expect(within(dialog).getByRole('option', { name: 'MMR-1' })).toHaveAttribute(
      'data-highlighted',
    );
  });

  it('shows its notice when nothing matches', async () => {
    stubViewport('desktop');
    render(<PaletteHarness run={() => undefined} />);
    const dialog = await openPalette();
    await userEvent.type(
      within(dialog).getByRole('combobox', { name: 'Jump to a record or action' }),
      'none',
    );
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0);
    expect(within(dialog).getByText('No records match “none”.')).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to its opener', async () => {
    stubViewport('desktop');
    render(<PaletteHarness run={() => undefined} />);
    await openPalette();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Jump' })).toHaveFocus();
  });
});
