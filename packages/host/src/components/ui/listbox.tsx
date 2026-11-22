import {
  Listbox as SdkListbox,
  ListboxGroupLabel as SdkListboxGroupLabel,
  ListboxItem as SdkListboxItem,
  ListboxItemIndicator as SdkListboxItemIndicator,
} from '@ui-sdk/react/listbox';
import type { ListboxItemProps, ListboxProps } from '@ui-sdk/react/listbox';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { mergeClassName } from './class-name';

/*
 * The Listbox primitive (ADR 0046): a standalone, selectable list in the
 * Meridian look. Its row, check, group label, and empty-state classes are the
 * single definition every picker shares: Combobox and Command import them, so
 * a Record picker (ADR 0019, MMR-736) looks the same wherever it opens.
 */

export { ListboxGroup, ListboxSeparator } from '@ui-sdk/react/listbox';

/** One option row: the highlight, the selected check's slot, and the disabled look. */
export const PICKER_ROW_CLASS =
  'flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-ink outline-none select-none max-md:py-2.5 data-[highlighted]:bg-accent/10 data-[highlighted]:inset-ring data-[highlighted]:inset-ring-accent/25 data-[disabled]:cursor-default data-[disabled]:text-ink-dim';

/**
 * A group's heading ("Recent", "Actions"): 13/20 ink-dim at 500, sentence case,
 * as a menu's group heading is (DESIGN.md, Type).
 */
export const PICKER_GROUP_LABEL_CLASS =
  'px-2 pt-2 pb-1 text-meta leading-5 font-medium text-ink-dim';

/**
 * The "No matches" line a picker shows when nothing fits the query. UI SDK
 * keeps the part in the page as a live region, so it takes no room while empty.
 */
export const PICKER_EMPTY_CLASS = 'px-2 py-3 text-meta text-ink-dim empty:p-0';

/** The element the selected check sits in, pushed to the row's end. */
export const PICKER_CHECK_CLASS = 'ml-auto shrink-0 text-accent';

/** The check drawn for a selected row; UI SDK's own icon needs web.css, which we do not load. */
export function PickerCheck({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-4', className)}
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

/** A record row's content: the mono id, then the title, which truncates. */
export function PickerRecord({ id, title }: { id: string; title: string }) {
  return (
    <>
      <span className="min-w-16 shrink-0 font-mono text-micro text-ink-dim">{id}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </>
  );
}

export function Listbox<T = string>({ className, ...props }: ListboxProps<T>) {
  return (
    <SdkListbox
      className={mergeClassName(
        'flex flex-col rounded-lg border border-line bg-well-900 p-1.5 outline-none focus-visible:border-accent',
        className,
      )}
      {...props}
    />
  );
}

/** An option; the check at its end appears while it is selected. */
export function ListboxItem<T = string>({
  className,
  children,
  ...props
}: ListboxItemProps<T> &
  Omit<ComponentProps<'div'>, keyof ListboxItemProps<T> | 'children'> & { children?: ReactNode }) {
  return (
    <SdkListboxItem<T> className={mergeClassName(PICKER_ROW_CLASS, className)} {...props}>
      {children}
      <SdkListboxItemIndicator className={PICKER_CHECK_CLASS}>
        <PickerCheck />
      </SdkListboxItemIndicator>
    </SdkListboxItem>
  );
}

export function ListboxGroupLabel({
  className,
  ...props
}: ComponentProps<typeof SdkListboxGroupLabel>) {
  return (
    <SdkListboxGroupLabel
      className={mergeClassName(PICKER_GROUP_LABEL_CLASS, className)}
      {...props}
    />
  );
}
