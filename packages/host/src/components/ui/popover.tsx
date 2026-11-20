import {
  PopoverContent as SdkPopoverContent,
  PopoverDescription as SdkPopoverDescription,
  PopoverTitle as SdkPopoverTitle,
} from '@ui-sdk/react/popover';
import type { ComponentProps } from 'react';

import { mergeClassName } from './class-name';

/*
 * The Popover primitive (ADR 0046): a non-modal panel anchored to its trigger,
 * for content that holds controls of its own, such as Record picker results
 * where no Combobox fits. Use Menu for a list of commands. Focus moves in on
 * open, and Escape closes and returns it to the trigger.
 */

/* Root, Trigger, and Close carry behavior only. */
export { Popover, PopoverClose, PopoverTrigger } from '@ui-sdk/react/popover';

export function PopoverContent({
  className,
  align = 'end',
  sideOffset = 8,
  ...props
}: ComponentProps<typeof SdkPopoverContent>) {
  return (
    <SdkPopoverContent
      align={align}
      sideOffset={sideOffset}
      className={mergeClassName(
        'z-50 flex max-h-[min(70dvh,640px)] w-[min(440px,calc(100vw-2rem))] origin-(--transform-origin) flex-col overflow-y-auto rounded-lg border border-line-bright bg-well-900 text-ink shadow-2xl outline-none transition-[opacity,scale] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

export function PopoverTitle({ className, ...props }: ComponentProps<typeof SdkPopoverTitle>) {
  return (
    <SdkPopoverTitle
      className={mergeClassName('text-sm font-semibold text-ink-bright', className)}
      {...props}
    />
  );
}

export function PopoverDescription({
  className,
  ...props
}: ComponentProps<typeof SdkPopoverDescription>) {
  return (
    <SdkPopoverDescription
      className={mergeClassName('text-meta text-ink-dim', className)}
      {...props}
    />
  );
}
