import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Field } from '../components/ui/field';
import { SegmentedControl } from '../components/ui/segmented-control';

const OPTIONS = [
  { label: 'Task', value: 'task' },
  { label: 'Bug', value: 'bug' },
  { label: 'Idea', value: 'idea' },
] as const;

type Kind = (typeof OPTIONS)[number]['value'];

function Harness({
  onChange,
  onSubmit,
}: {
  onChange?: (value: Kind) => void;
  onSubmit?: () => void;
}) {
  const [value, setValue] = useState<Kind>('bug');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <SegmentedControl
        ariaLabel="Kind"
        options={OPTIONS}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </form>
  );
}

describe('SegmentedControl keyboard', () => {
  it('Enter on a segment does not submit the surrounding form', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSubmit={onSubmit} />);
    screen.getByRole('radio', { name: 'Bug' }).focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Home selects and focuses the first segment', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    screen.getByRole('radio', { name: 'Bug' }).focus();
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenCalledWith('task');
    expect(screen.getByRole('radio', { name: 'Task' })).toHaveFocus();
  });

  it('End selects and focuses the last segment', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    screen.getByRole('radio', { name: 'Bug' }).focus();
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenCalledWith('idea');
    expect(screen.getByRole('radio', { name: 'Idea' })).toHaveFocus();
  });

  it('arrow keys move the selection and focus', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    screen.getByRole('radio', { name: 'Bug' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('idea');
    expect(screen.getByRole('radio', { name: 'Idea' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('task');
    expect(screen.getByRole('radio', { name: 'Task' })).toHaveFocus();
  });
});

describe('SegmentedControl in a disabled Field', () => {
  it('Home and End change nothing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Field disabled>
        <SegmentedControl ariaLabel="Kind" options={OPTIONS} value="bug" onChange={onChange} />
      </Field>,
    );
    screen.getByRole('radio', { name: 'Bug' }).focus();
    await user.keyboard('{End}');
    await user.keyboard('{Home}');
    expect(onChange).not.toHaveBeenCalled();
  });
});
