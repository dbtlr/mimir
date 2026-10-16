import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useHotkey } from '../lib/use-hotkey';

function Harness({
  onFire,
  enabled,
  withInput,
  withDialog,
  withMenu,
  withListbox,
  focusedRole,
}: {
  onFire: () => void;
  enabled?: boolean;
  withInput?: boolean;
  withDialog?: boolean;
  withMenu?: boolean;
  withListbox?: boolean;
  focusedRole?: 'menuitem' | 'option' | 'combobox';
}) {
  useHotkey('s', onFire, { enabled });
  return (
    <div>
      {withInput === true && <input aria-label="box" />}
      {withDialog === true && (
        <div role="dialog" aria-label="open modal">
          modal
        </div>
      )}
      {withMenu === true && (
        <div role="menu" aria-label="open menu">
          menu
        </div>
      )}
      {withListbox === true && (
        <div role="listbox" aria-label="open listbox">
          listbox
        </div>
      )}
      {focusedRole !== undefined && (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div role={focusedRole} tabIndex={0} aria-label="focused item">
          item
        </div>
      )}
    </div>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useHotkey (MMR-247 capture trigger)', () => {
  it('fires on a bare `s` keydown', async () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);
    await userEvent.keyboard('s');
    expect(onFire).toHaveBeenCalledOnce();
  });

  it('does not fire while focus is in an input', async () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} withInput />);
    await userEvent.click(screen.getByRole('textbox', { name: 'box' }));
    await userEvent.keyboard('s');
    expect(onFire).not.toHaveBeenCalled();
  });

  it('does not fire with a modifier held (⌘s / ctrl+s)', async () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);
    await userEvent.keyboard('{Meta>}s{/Meta}');
    await userEvent.keyboard('{Control>}s{/Control}');
    expect(onFire).not.toHaveBeenCalled();
  });

  it('does not fire when another dialog is already open', async () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} withDialog />);
    await userEvent.keyboard('s');
    expect(onFire).not.toHaveBeenCalled();
  });

  it('does not fire when an open menu is present (base-ui Menu typeahead)', async () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} withMenu />);
    await userEvent.keyboard('s');
    expect(onFire).not.toHaveBeenCalled();
  });

  it('does not fire when an open listbox is present (base-ui Select typeahead)', async () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} withListbox />);
    await userEvent.keyboard('s');
    expect(onFire).not.toHaveBeenCalled();
  });

  it.each(['menuitem', 'option', 'combobox'] as const)(
    'does not fire while focus is on a %s',
    async (role) => {
      const onFire = vi.fn();
      render(<Harness onFire={onFire} focusedRole={role} />);
      screen.getByRole(role, { name: 'focused item' }).focus();
      await userEvent.keyboard('s');
      expect(onFire).not.toHaveBeenCalled();
    },
  );

  it('does not fire when disabled', async () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} enabled={false} />);
    await userEvent.keyboard('s');
    expect(onFire).not.toHaveBeenCalled();
  });
});
