import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useHotkey } from '../lib/use-hotkey';

function Harness({
  onFire,
  enabled,
  withInput,
  withDialog,
}: {
  onFire: () => void;
  enabled?: boolean;
  withInput?: boolean;
  withDialog?: boolean;
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

  it('does not fire when disabled', async () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} enabled={false} />);
    await userEvent.keyboard('s');
    expect(onFire).not.toHaveBeenCalled();
  });
});
