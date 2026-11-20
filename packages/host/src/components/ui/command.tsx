import {
  Command as SdkCommand,
  CommandEmpty as SdkCommandEmpty,
  CommandGroupLabel as SdkCommandGroupLabel,
  CommandInput as SdkCommandInput,
  CommandItem as SdkCommandItem,
  CommandList as SdkCommandList,
  CommandShortcut as SdkCommandShortcut,
} from '@ui-sdk/react/command';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';
import { mergeClassName } from './class-name';
import { PICKER_EMPTY_CLASS, PICKER_GROUP_LABEL_CLASS, PICKER_ROW_CLASS } from './listbox';

/*
 * The Command primitive (ADR 0046): a search box over grouped, keyboard-driven
 * results, in the Meridian look. The jump palette is built from it, usually
 * inside a Dialog (ADR 0019, MMR-736). Rows share Listbox's row classes.
 */

export { CommandGroup, CommandSeparator } from '@ui-sdk/react/command';

export function Command({ className, ...props }: ComponentProps<typeof SdkCommand>) {
  return <SdkCommand className={mergeClassName('flex min-h-0 flex-col', className)} {...props} />;
}

/** The search box: a search glyph, then the field, ruled off from the results. */
export function CommandInput({ className, ...props }: ComponentProps<typeof SdkCommandInput>) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-4 shrink-0 text-ink-faint"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <SdkCommandInput
        className={mergeClassName(
          'min-w-0 flex-1 bg-transparent text-base text-ink-bright outline-none placeholder:text-ink-faint',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof SdkCommandList>) {
  return (
    <SdkCommandList
      className={mergeClassName('min-h-0 flex-1 overflow-y-auto px-2 py-1.5', className)}
      {...props}
    />
  );
}

export function CommandGroupLabel({
  className,
  ...props
}: ComponentProps<typeof SdkCommandGroupLabel>) {
  return (
    <SdkCommandGroupLabel
      className={mergeClassName(PICKER_GROUP_LABEL_CLASS, className)}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof SdkCommandItem>) {
  return <SdkCommandItem className={mergeClassName(PICKER_ROW_CLASS, className)} {...props} />;
}

export function CommandEmpty({
  className,
  children = 'No matches',
  ...props
}: ComponentProps<typeof SdkCommandEmpty>) {
  return (
    <SdkCommandEmpty className={mergeClassName(PICKER_EMPTY_CLASS, 'px-4', className)} {...props}>
      {children}
    </SdkCommandEmpty>
  );
}

/** The keys that run a row, shown at its end. */
export function CommandShortcut({
  className,
  ...props
}: ComponentProps<typeof SdkCommandShortcut>) {
  return (
    <SdkCommandShortcut
      className={mergeClassName('ml-auto shrink-0 font-mono text-micro text-ink-faint', className)}
      {...props}
    />
  );
}

/** The key-hint line under the results, as in the jump palette. */
export function CommandFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex flex-wrap gap-3.5 border-t border-line px-4 py-2 font-mono text-micro text-ink-faint',
        className,
      )}
      {...props}
    />
  );
}
