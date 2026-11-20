import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionMenu } from '../components/patterns/action-menu';
import type { ActionMenuEntry } from '../components/patterns/action-menu';
import { DestructiveConfirm } from '../components/patterns/destructive-confirm';
import { DESTRUCTIVE_OUTLINE } from '../components/ui/action-button';
import { stubViewport } from './viewport';

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

  it('an action that opens a confirm gives it focus, and focus ends on the trigger after it closes', async () => {
    viewport(desktop);
    render(<WithConfirm />);
    const trigger = await open();
    await userEvent.click(screen.getByRole(desktop ? 'menuitem' : 'button', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Remove it?');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });
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

/** The menu item on a desktop, or the sheet row on a phone. */
const itemRole = (desktop: boolean) => (desktop ? 'menuitem' : 'button');

describe.each([
  ['menu', true],
  ['sheet', false],
] as const)('Action menu rows as a %s', (_name, desktop) => {
  const open = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await screen.findByRole(desktop ? 'menu' : 'dialog');
  };

  // ADR 0019's MMR-635 refinement: an action that removes wears the red hairline, not only the red label.
  it('a destructive action wears the red hairline', async () => {
    viewport(desktop);
    render(
      <Harness
        entries={[
          { key: 'plain', kind: 'action', label: 'Keep' },
          { destructive: true, key: 'remove', kind: 'action', label: 'Remove' },
        ]}
      />,
    );
    await open();
    const hairline = DESTRUCTIVE_OUTLINE.split(' ');
    expect(screen.getByRole(itemRole(desktop), { name: 'Remove' })).toHaveClass(...hairline);
    expect(screen.getByRole(itemRole(desktop), { name: 'Keep' })).not.toHaveClass(hairline[0]!);
  });

  it('Enter on an action runs it once, closes, and returns focus to the trigger', async () => {
    viewport(desktop);
    const once = vi.fn();
    render(<Harness entries={[{ key: 'a', kind: 'action', label: 'Do it', onSelect: once }]} />);
    const trigger = screen.getByRole('button', { name: 'More' });
    act(() => {
      trigger.focus();
    });
    await userEvent.keyboard('{Enter}');
    const item = await screen.findByRole(itemRole(desktop), { name: 'Do it' });
    act(() => {
      item.focus();
    });
    await userEvent.keyboard('{Enter}');
    expect(once).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole(desktop ? 'menu' : 'dialog')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });

  it('a disabled action runs neither on a press nor on Enter', async () => {
    viewport(desktop);
    const never = vi.fn();
    render(
      <Harness
        entries={[{ disabled: true, key: 'a', kind: 'action', label: 'Do it', onSelect: never }]}
      />,
    );
    await open();
    const item = screen.getByRole(itemRole(desktop), { name: 'Do it' });
    fireEvent.click(item);
    act(() => {
      item.focus();
    });
    await userEvent.keyboard('{Enter}');
    expect(never).not.toHaveBeenCalled();
  });

  it('a disabled link row does not navigate and says it is disabled', async () => {
    viewport(desktop);
    render(
      <Harness
        entries={[
          {
            disabled: true,
            key: 'a',
            kind: 'action',
            label: 'Go',
            // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- the pattern gives the row its label
            render: <a href="#gone" />,
          },
        ]}
      />,
    );
    await open();
    const link = screen.getByText('Go').closest('a')!;
    const press = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link.dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
    expect(link).toHaveAttribute('aria-disabled', 'true');
  });

  it('a link row keeps its own class and press handler beside the pattern’s', async () => {
    viewport(desktop);
    const own = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    const chosen = vi.fn();
    render(
      <Harness
        entries={[
          {
            key: 'a',
            kind: 'action',
            label: 'Go',
            onSelect: chosen,
            // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- the pattern gives the row its label
            render: <a href="#go" className="caller-class" onClick={own} />,
          },
        ]}
      />,
    );
    await open();
    const link = screen.getByText('Go').closest('a')!;
    expect(link).toHaveClass('caller-class', 'rounded-sm');
    await userEvent.click(link);
    expect(own).toHaveBeenCalledOnce();
    expect(chosen).toHaveBeenCalledOnce();
  });
});

/** An action that opens a Destructive confirm, as Remove this browser does. */
function OpensConfirm() {
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
      >
        It cannot be undone.
      </DestructiveConfirm>
    </>
  );
}

/**
 * Press `key` on the focused element as Chromium does: keydown there, then keypress, keyup, and the
 * button press each go to whatever holds focus by then. A button presses on Enter's keypress and on
 * Space's keyup, unless that event's default is prevented. jsdom and user-event send them all to the
 * first element, so they cannot show a keydown handler that moves focus.
 */
/** The element that holds focus, or the body. */
const at = () => document.activeElement ?? document.body;

async function pressAsChromium(key: 'Enter' | ' ') {
  const code = key === 'Enter' ? 'Enter' : 'Space';
  const charCode = key === 'Enter' ? 13 : 32;
  // Microtasks run between the events, as they do between a browser's event dispatches; timers do not.
  await act(async () => {
    fireEvent.keyDown(at(), { charCode, code, key });
    await Promise.resolve();
  });
  await act(async () => {
    const target = at();
    const kept = fireEvent.keyPress(target, { charCode, code, key });
    if (key === 'Enter' && kept && target instanceof HTMLButtonElement) {
      target.click();
    }
    await Promise.resolve();
  });
  await act(async () => {
    const target = at();
    const kept = fireEvent.keyUp(target, { charCode, code, key });
    if (key === ' ' && kept && target instanceof HTMLButtonElement) {
      target.click();
    }
    await Promise.resolve();
  });
}

describe.each([
  ['menu', true],
  ['sheet', false],
] as const)('An action that opens a confirm, as a %s', (_name, desktop) => {
  // In Chromium the menu chose on keydown and the confirm took focus at once, so the same key's keypress
  // pressed the confirm's Cancel: Remove by keyboard opened the confirm and closed it again.
  it.each(['Enter', ' '] as const)(
    '%j on it leaves the confirm open on Cancel, and Escape returns focus to the trigger',
    async (key) => {
      stubViewport(desktop ? 'desktop' : 'phone');
      render(<OpensConfirm />);
      const trigger = screen.getByRole('button', { name: 'More' });
      await userEvent.click(trigger);
      const item = await screen.findByRole(itemRole(desktop), { name: 'Remove' });
      act(() => {
        item.focus();
      });
      await pressAsChromium(key);
      const confirm = await screen.findByRole('alertdialog', { name: 'Remove it?' });
      // Let a close the keys started finish, had they pressed Cancel.
      await act(async () => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 50);
        await promise;
      });
      expect(confirm).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).toBeNull();
      });
      expect(trigger).toHaveFocus();
    },
  );
});

const KEY_INIT = {
  ' ': { charCode: 32, code: 'Space' },
  ArrowRight: { code: 'ArrowRight' },
  Enter: { charCode: 13, code: 'Enter' },
  Tab: { code: 'Tab' },
} as const;

/** One key event as Chromium sends it: to whatever holds focus, pressing a button on Enter's keypress and Space's keyup. */
async function send(type: 'down' | 'press' | 'up', name: keyof typeof KEY_INIT, repeat = false) {
  const init = { ...KEY_INIT[name], key: name, repeat };
  let kept = true;
  await act(async () => {
    const target = at();
    if (type === 'down') {
      kept = fireEvent.keyDown(target, init);
    } else if (type === 'press') {
      kept = fireEvent.keyPress(target, init);
      if (name === 'Enter' && kept && target instanceof HTMLButtonElement) {
        target.click();
      }
    } else {
      kept = fireEvent.keyUp(target, init);
      if (name === ' ' && kept && target instanceof HTMLButtonElement) {
        target.click();
      }
    }
    await Promise.resolve();
  });
  return kept;
}

/** Let a close that the keys started finish, had they pressed something. */
const pause = () =>
  act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  });

/** Open the Action menu and put focus on its Remove row. */
async function focusRemove(desktop: boolean) {
  stubViewport(desktop ? 'desktop' : 'phone');
  render(<OpensConfirm />);
  await userEvent.click(screen.getByRole('button', { name: 'More' }));
  const item = await screen.findByRole(itemRole(desktop), { name: 'Remove' });
  act(() => {
    item.focus();
  });
}

const cancel = () => screen.getByRole('button', { name: 'Cancel' });

/** The confirm is open on Cancel, and a fresh Enter presses Cancel and closes it. */
async function expectHeldThenFresh() {
  await pause();
  expect(screen.getByRole('alertdialog', { name: 'Remove it?' })).toBeInTheDocument();
  expect(cancel()).toHaveFocus();
  expect(screen.queryByRole('dialog', { name: 'Actions' })).toBeNull();
  await send('down', 'Enter');
  await expect(send('press', 'Enter')).resolves.toBe(true);
  await send('up', 'Enter');
  await waitFor(() => {
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
}

describe.each([
  ['menu', true],
  ['sheet', false],
] as const)('The key that chose a row of the %s', (_name, desktop) => {
  // A held key repeats: its later keydowns and keypresses went to the confirm that took focus, and
  // pressed its Cancel; on a phone, a further repeat then pressed the row and opened the sheet again.
  it('held, never presses what took focus, until it comes up', async () => {
    await focusRemove(desktop);
    await send('down', 'Enter');
    await send('press', 'Enter');
    await screen.findByRole('alertdialog', { name: 'Remove it?' });
    for (let turn = 0; turn < 4; turn += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each repeat follows the one before it
      await send('down', 'Enter', true);
      // oxlint-disable-next-line no-await-in-loop -- each repeat follows the one before it
      await send('press', 'Enter', true);
    }
    await send('up', 'Enter');
    await expectHeldThenFresh();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  // Holding Enter on the trigger opens the menu or sheet, and a repeat then chooses the row that has focus.
  it('held on the trigger, chooses by a repeat and holds from there', async () => {
    stubViewport(desktop ? 'desktop' : 'phone');
    render(<OpensConfirm />);
    act(() => {
      screen.getByRole('button', { name: 'More' }).focus();
    });
    await send('down', 'Enter');
    await send('press', 'Enter');
    await pause();
    for (let turn = 0; turn < 4; turn += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each repeat follows the one before it
      await send('down', 'Enter', true);
      // oxlint-disable-next-line no-await-in-loop -- each repeat follows the one before it
      await send('press', 'Enter', true);
    }
    await send('up', 'Enter');
    await expectHeldThenFresh();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('another key while it is held does not release it', async () => {
    await focusRemove(desktop);
    await send('down', 'Enter');
    await send('press', 'Enter');
    await screen.findByRole('alertdialog', { name: 'Remove it?' });
    await expect(send('down', 'ArrowRight')).resolves.toBe(true);
    await send('up', 'ArrowRight');
    await send('down', 'Enter', true);
    await send('press', 'Enter', true);
    await send('up', 'Enter');
    await expectHeldThenFresh();
  });

  it('holds only that key: a fast Tab still moves on', async () => {
    await focusRemove(desktop);
    await send('down', 'Enter');
    await send('press', 'Enter');
    await screen.findByRole('alertdialog', { name: 'Remove it?' });
    await expect(send('down', 'Tab')).resolves.toBe(true);
    await send('up', 'Enter');
    act(() => {
      cancel().focus();
    });
    await expectHeldThenFresh();
  });

  it('is released when the window loses focus, as its keyup may never arrive', async () => {
    await focusRemove(desktop);
    await send('down', 'Enter');
    await send('press', 'Enter');
    await screen.findByRole('alertdialog', { name: 'Remove it?' });
    act(() => {
      globalThis.dispatchEvent(new Event('blur'));
    });
    await expect(send('press', 'Enter')).resolves.toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  it('a row chosen by a pointer holds nothing', async () => {
    await focusRemove(desktop);
    await userEvent.click(screen.getByRole(itemRole(desktop), { name: 'Remove' }));
    await screen.findByRole('alertdialog', { name: 'Remove it?' });
    await waitFor(() => {
      expect(cancel()).toHaveFocus();
    });
    await expectHeldThenFresh();
  });
});

test('a Space that chose a menu row holds only Space: Enter before its keyup presses Cancel', async () => {
  await focusRemove(true);
  await send('down', ' ');
  await send('press', ' ');
  await screen.findByRole('alertdialog', { name: 'Remove it?' });
  await send('down', 'Enter');
  await expect(send('press', 'Enter')).resolves.toBe(true);
  await send('up', 'Enter');
  await send('up', ' ');
  await waitFor(() => {
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

function ThemeMenu() {
  const [theme, setTheme] = useState('dark');
  return (
    <>
      <output aria-label="theme">{theme}</output>
      <ActionMenu
        title="Actions"
        trigger={Trigger}
        entries={[
          {
            key: 'theme',
            kind: 'choice',
            label: 'Theme',
            onChange: setTheme,
            options: [
              { label: 'Dark', value: 'dark' },
              { label: 'Light', value: 'light' },
              { label: 'System', value: 'system' },
            ],
            value: theme,
          },
        ]}
      />
    </>
  );
}

describe('The Choice in a sheet', () => {
  it('is one tab stop whose arrow keys move the choice, and keeps the sheet open', async () => {
    stubViewport('phone');
    render(<ThemeMenu />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    const group = await screen.findByRole('radiogroup', { name: 'Theme' });
    const dark = screen.getByRole('radio', { name: 'Dark' });
    expect(dark).toBeChecked();
    expect(dark).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('tabindex', '-1');
    act(() => {
      dark.focus();
    });
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
    expect(screen.getByLabelText('theme')).toHaveTextContent('light');
    await userEvent.tab();
    expect(group).not.toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // A radio group checks on Space and the arrow keys, not Enter (WAI-ARIA's radio group pattern).
  it('Space on an option chooses it and keeps the sheet open', async () => {
    stubViewport('phone');
    render(<ThemeMenu />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    const light = await screen.findByRole('radio', { name: 'Light' });
    act(() => {
      light.focus();
    });
    await userEvent.keyboard(' ');
    expect(screen.getByLabelText('theme')).toHaveTextContent('light');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Action menu across the breakpoint', () => {
  it('a sheet that becomes a menu still runs its action and returns focus to the trigger', async () => {
    const resize = stubViewport('phone');
    const once = vi.fn();
    render(<Harness entries={[{ key: 'a', kind: 'action', label: 'Do it', onSelect: once }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await screen.findByRole('dialog');
    resize('desktop');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Do it' }));
    expect(once).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
  });

  it.each(['desktop', 'phone'] as const)(
    'on a %s, a parent that keeps it open keeps it open after an action',
    async (width) => {
      stubViewport(width);
      const once = vi.fn();
      render(
        <ActionMenu
          title="Actions"
          open
          trigger={Trigger}
          onOpenChange={() => undefined}
          entries={[{ key: 'a', kind: 'action', label: 'Do it', onSelect: once }]}
        />,
      );
      await userEvent.click(
        await screen.findByRole(itemRole(width === 'desktop'), { name: 'Do it' }),
      );
      expect(once).toHaveBeenCalledOnce();
      expect(screen.getByRole(width === 'desktop' ? 'menu' : 'dialog')).toBeInTheDocument();
    },
  );
});

/** Rows whose own action removes them, as removing a record does; `main` takes focus when its row is gone. */
function RemovesItsRow() {
  const [rows, setRows] = useState(['a', 'b']);
  return (
    <main tabIndex={-1}>
      {rows.map((row) => (
        <ActionMenu
          key={row}
          title={`Row ${row}`}
          trigger={<button type="button" aria-label={`More ${row}`} />}
          finalFocus={() => document.querySelector('main')}
          entries={[
            {
              key: 'delete',
              kind: 'action',
              label: 'Delete row',
              onSelect: () => {
                setRows((all) => all.filter((each) => each !== row));
              },
            },
          ]}
        />
      ))}
    </main>
  );
}

describe.each(['desktop', 'phone'] as const)('Action menu finalFocus (%s)', (width) => {
  it('sends focus where the caller says when the action removes the trigger', async () => {
    stubViewport(width);
    render(<RemovesItsRow />);
    await userEvent.click(screen.getByRole('button', { name: 'More a' }));
    await userEvent.click(
      await screen.findByRole(itemRole(width === 'desktop'), { name: 'Delete row' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'More a' })).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('main')).toHaveFocus();
    });
  });
});
