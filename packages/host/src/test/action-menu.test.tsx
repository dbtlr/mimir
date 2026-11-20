import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionMenu } from '../components/patterns/action-menu';
import type { ActionMenuEntry } from '../components/patterns/action-menu';
import { DestructiveConfirm } from '../components/patterns/destructive-confirm';

/** Stub `matchMedia`: every query matches when `desktop` is true. */
function viewport(desktop: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener: () => undefined,
    matches: desktop,
    media: query,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const Trigger = <button type="button" aria-label="More" />;

function Harness({
  entries,
  onOpenChange,
}: {
  entries: ActionMenuEntry[];
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <ActionMenu
      title="Actions"
      description="Pick one"
      trigger={Trigger}
      entries={entries}
      onOpenChange={onOpenChange}
    />
  );
}

const run = vi.fn();
const entries: ActionMenuEntry[] = [
  { key: 'a', kind: 'action', label: 'Do it', onSelect: run },
  { keepOpen: true, key: 'stay', kind: 'action', label: 'Check', onSelect: run },
];

describe('Action menu surface', () => {
  it('opens as an anchored menu from md up', async () => {
    viewport(true);
    render(<Harness entries={entries} />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await expect(screen.findByRole('menu')).resolves.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Do it' })).toBeInTheDocument();
  });

  it('opens as a bottom sheet with 44px rows below md', async () => {
    viewport(false);
    render(<Harness entries={entries} />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    const sheet = await screen.findByRole('dialog', { name: 'Actions' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(sheet).toHaveAttribute('data-side', 'bottom');
    expect(screen.getByRole('button', { name: 'Do it' })).toHaveClass('min-h-11');
  });

  it('closes after a plain action and runs it', async () => {
    viewport(false);
    run.mockClear();
    render(<Harness entries={entries} />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Do it' }));
    expect(run).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe.each([
  ['menu', true],
  ['sheet', false],
] as const)('Action menu as a %s', (_name, desktop) => {
  const open = async () => {
    viewport(desktop);
    const trigger = screen.getByRole('button', { name: 'More' });
    await userEvent.click(trigger);
    await screen.findByRole(desktop ? 'menu' : 'dialog');
    return trigger;
  };

  it('Escape closes it and focus returns to the trigger', async () => {
    viewport(desktop);
    render(<Harness entries={entries} />);
    const trigger = await open();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole(desktop ? 'menu' : 'dialog')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });

  it('a plain action closes it and focus returns to the trigger', async () => {
    viewport(desktop);
    render(<Harness entries={entries} />);
    const trigger = await open();
    await userEvent.click(screen.getByRole(desktop ? 'menuitem' : 'button', { name: 'Do it' }));
    await waitFor(() => {
      expect(screen.queryByRole(desktop ? 'menu' : 'dialog')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });

  it('keepOpen leaves it open', async () => {
    viewport(desktop);
    render(<Harness entries={entries} />);
    await open();
    await userEvent.click(screen.getByRole(desktop ? 'menuitem' : 'button', { name: 'Check' }));
    expect(screen.getByRole(desktop ? 'menu' : 'dialog')).toBeInTheDocument();
  });

  it('a radio item changes the choice and keeps it open', async () => {
    viewport(desktop);
    const onChange = vi.fn();
    const choice: ActionMenuEntry = {
      key: 'theme',
      kind: 'choice',
      label: 'Theme',
      onChange,
      options: [
        { label: 'Dark', value: 'dark' },
        { label: 'Light', value: 'light' },
      ],
      value: 'dark',
    };
    render(<Harness entries={[choice]} />);
    await open();
    const dark = screen.getByRole(desktop ? 'menuitemradio' : 'radio', { name: 'Dark' });
    expect(dark).toBeChecked();
    await userEvent.click(screen.getByRole(desktop ? 'menuitemradio' : 'radio', { name: 'Light' }));
    expect(onChange).toHaveBeenCalledWith('light');
    expect(screen.getByRole(desktop ? 'menu' : 'dialog')).toBeInTheDocument();
  });

  it('an action that moves focus opens a confirm and focus ends on the trigger after it closes', async () => {
    viewport(desktop);
    render(<WithConfirm />);
    const trigger = await open();
    await userEvent.click(screen.getByRole(desktop ? 'menuitem' : 'button', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Remove it?');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });
});

function WithConfirm() {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <ActionMenu
        title="Actions"
        trigger={Trigger}
        entries={[
          {
            destructive: true,
            key: 'remove',
            kind: 'action',
            label: 'Remove',
            movesFocus: true,
            onSelect: () => setAsking(true),
          },
        ]}
      />
      <DestructiveConfirm
        open={asking}
        onClose={() => setAsking(false)}
        title="Remove it?"
        commitLabel="Remove"
        onConfirm={() => undefined}
        finalFocus={() => screen.getByRole('button', { name: 'More' })}
      >
        It cannot be undone.
      </DestructiveConfirm>
    </>
  );
}

describe('Action menu control', () => {
  it('reports open changes and opens when controlled', async () => {
    viewport(false);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ActionMenu
        title="Actions"
        trigger={Trigger}
        entries={entries}
        open
        onOpenChange={onOpenChange}
      />,
    );
    await expect(screen.findByRole('dialog', { name: 'Actions' })).resolves.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(
      <ActionMenu
        title="Actions"
        trigger={Trigger}
        entries={entries}
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
