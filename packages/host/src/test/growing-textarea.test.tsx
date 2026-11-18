import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GROWING_TEXTAREA_MAX_HEIGHT, GrowingTextarea } from '../components/ui/growing-textarea';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stubScrollHeight = (height: number) =>
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(height);

describe('GrowingTextarea', () => {
  it('renders one row', () => {
    render(<GrowingTextarea aria-label="note" />);
    expect(screen.getByLabelText('note')).toHaveAttribute('rows', '1');
  });

  it('without field-sizing, sets its height from its content', () => {
    vi.stubGlobal('CSS', { supports: () => false });
    stubScrollHeight(60);
    render(<GrowingTextarea aria-label="note" />);
    expect(screen.getByLabelText('note').style.height).toBe('62px');
  });

  it('without field-sizing, stops growing at the cap', () => {
    vi.stubGlobal('CSS', { supports: () => false });
    stubScrollHeight(500);
    render(<GrowingTextarea aria-label="note" />);
    expect(screen.getByLabelText('note').style.height).toBe(
      `${String(GROWING_TEXTAREA_MAX_HEIGHT)}px`,
    );
    expect(GROWING_TEXTAREA_MAX_HEIGHT).toBe(110);
  });

  it('with field-sizing, leaves the height to CSS', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    stubScrollHeight(60);
    render(<GrowingTextarea aria-label="note" />);
    expect(screen.getByLabelText('note').style.height).toBe('');
  });

  it('forwards onInput and refits on input', () => {
    vi.stubGlobal('CSS', { supports: () => false });
    const scroll = stubScrollHeight(30);
    const onInput = vi.fn();
    render(<GrowingTextarea aria-label="note" onInput={onInput} />);
    scroll.mockReturnValue(80);
    fireEvent.input(screen.getByLabelText('note'), { target: { value: 'a\nb\nc' } });
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('note').style.height).toBe('82px');
  });

  it('forwards a ref object and a ref callback', () => {
    const object = createRef<HTMLTextAreaElement>();
    const callback = vi.fn();
    render(
      <>
        <GrowingTextarea aria-label="a" ref={object} />
        <GrowingTextarea aria-label="b" ref={callback} />
      </>,
    );
    expect(object.current).toBe(screen.getByLabelText('a'));
    expect(callback).toHaveBeenCalledWith(screen.getByLabelText('b'));
  });
});
