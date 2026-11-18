import { useLayoutEffect, useRef } from 'react';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/** Four lines of 22px text plus the box's padding and border: where the box stops growing. */
export const GROWING_TEXTAREA_MAX_HEIGHT = 110;

/** Whether the browser sizes a text box to its content in CSS (`field-sizing: content`). */
function sizesInCss(): boolean {
  return typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
}

/**
 * A text box that starts one line tall, grows with its text to four lines,
 * then scrolls (ADR 0019, MMR-703 refinement). Browsers with `field-sizing`
 * do this in CSS; elsewhere the box sets its own height on each change.
 */
export function GrowingTextarea({ className, onInput, ref, ...props }: ComponentProps<'textarea'>) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = box.current;
    if (el === null || sizesInCss()) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight + 2, GROWING_TEXTAREA_MAX_HEIGHT))}px`;
  };
  useLayoutEffect(fit, [props.value]);
  return (
    <textarea
      rows={1}
      {...props}
      ref={(el) => {
        box.current = el;
        if (typeof ref === 'function') {
          ref(el);
        } else if (ref) {
          ref.current = el;
        }
      }}
      onInput={(event) => {
        fit();
        onInput?.(event);
      }}
      className={cn(
        'max-h-[110px] min-h-11 w-full resize-none overflow-y-auto rounded-md border border-line-bright bg-well-950 px-3 py-2.5 text-[15px] leading-[22px] text-ink-bright outline-none [field-sizing:content] placeholder:text-ink-ghost focus-visible:border-accent',
        className,
      )}
    />
  );
}
