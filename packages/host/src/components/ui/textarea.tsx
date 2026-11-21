import { Textarea as SdkTextarea } from '@ui-sdk/react/textarea';
import type { ComponentProps } from 'react';

import { mergeClassName } from './class-name';
import { TEXT_FIELD_CLASS } from './input';

/*
 * The Textarea primitive (ADR 0046): a multi-line text box. `grow` gives the
 * console's composer behavior: one line tall, growing with the text to four
 * lines, then scrolling (ADR 0019, MMR-703 refinement, MMR-736). Reason
 * dialogs and the Walkthrough use it.
 */

export type TextareaProps = ComponentProps<typeof SdkTextarea> & {
  /** Start one line tall and grow with the text to four lines, then scroll. */
  grow?: boolean;
};

export function Textarea({ className, grow = false, ...props }: TextareaProps) {
  return (
    <SdkTextarea
      autoResize={grow}
      rows={grow ? 1 : undefined}
      {...props}
      className={mergeClassName(
        TEXT_FIELD_CLASS,
        'py-2.5 leading-[22px]',
        // Three lines (88) to start, in a form; it grows by dragging its corner.
        grow ? 'max-h-[110px] min-h-11 resize-none overflow-y-auto' : 'min-h-22 resize-y',
        className,
      )}
    />
  );
}
