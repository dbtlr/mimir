import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Textarea } from '../components/ui/textarea';

/*
 * The Textarea primitive's `grow` variant, which the Composer and the
 * Walkthrough use (ADR 0019, MMR-703 refinement): one line tall, growing with
 * its text to four lines, then scrolling. It replaced GrowingTextarea, whose
 * fallback added 2px to `scrollHeight` and capped the height in an inline
 * style. UI SDK's `autoResize` fallback adds the box's own border width
 * (`offsetHeight - clientHeight`, 2px in a browser, 0 in jsdom, which lays
 * nothing out) and leaves the cap to the CSS `max-height`.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stubScrollHeight = (height: number) =>
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(height);

/** Four lines of 22px text plus the box's padding and border: where the box stops growing. */
const FOUR_LINES = 'max-h-[110px]';

describe('Textarea grow', () => {
  it('renders one row', () => {
    render(<Textarea grow aria-label="note" />);
    expect(screen.getByLabelText('note')).toHaveAttribute('rows', '1');
  });

  it('without field-sizing, sets its height from its content', () => {
    vi.stubGlobal('CSS', { supports: () => false });
    stubScrollHeight(60);
    render(<Textarea grow aria-label="note" />);
    expect(screen.getByLabelText('note').style.height).toBe('60px');
  });

  it('without field-sizing, stops growing at four lines, by its CSS cap', () => {
    vi.stubGlobal('CSS', { supports: () => false });
    stubScrollHeight(500);
    render(<Textarea grow aria-label="note" />);
    const box = screen.getByLabelText('note');
    expect(box).toHaveClass(FOUR_LINES, 'overflow-y-auto');
  });

  it('with field-sizing, leaves the height to CSS, capped at the same height', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    stubScrollHeight(60);
    render(<Textarea grow aria-label="note" />);
    const box = screen.getByLabelText('note');
    expect(box.style.height).toBe('');
    expect(box.style.getPropertyValue('field-sizing')).toBe('content');
    expect(box).toHaveClass(FOUR_LINES);
  });

  it('forwards onInput and refits on input', () => {
    vi.stubGlobal('CSS', { supports: () => false });
    const scroll = stubScrollHeight(30);
    const onInput = vi.fn();
    render(<Textarea grow aria-label="note" onInput={onInput} />);
    scroll.mockReturnValue(80);
    fireEvent.input(screen.getByLabelText('note'), { target: { value: 'a\nb\nc' } });
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('note').style.height).toBe('80px');
  });

  it('forwards a ref object and a ref callback', () => {
    const object = createRef<HTMLTextAreaElement>();
    const callback = vi.fn();
    render(
      <>
        <Textarea grow aria-label="a" ref={object} />
        <Textarea grow aria-label="b" ref={callback} />
      </>,
    );
    expect(object.current).toBe(screen.getByLabelText('a'));
    expect(callback).toHaveBeenCalledWith(screen.getByLabelText('b'));
  });
});
