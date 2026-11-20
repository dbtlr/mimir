import {
  ComboboxContent as SdkComboboxContent,
  ComboboxEmpty as SdkComboboxEmpty,
  ComboboxGroupLabel as SdkComboboxGroupLabel,
  ComboboxInput as SdkComboboxInput,
  ComboboxItem as SdkComboboxItem,
  ComboboxItemIndicator as SdkComboboxItemIndicator,
  ComboboxLabel as SdkComboboxLabel,
  ComboboxList as SdkComboboxList,
  ComboboxTrigger as SdkComboboxTrigger,
} from '@ui-sdk/react/combobox';
import type { ComboboxItemProps } from '@ui-sdk/react/combobox';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { FIELD_LABEL_CLASS } from './field';
import {
  PICKER_CHECK_CLASS,
  PICKER_EMPTY_CLASS,
  PICKER_GROUP_LABEL_CLASS,
  PICKER_ROW_CLASS,
  PickerCheck,
} from './listbox';

/*
 * The Combobox primitive (ADR 0046): an input that filters a popup list of
 * records and picks one. It is the engine of the Record picker pattern (ADR
 * 0019, MMR-736), which composes it for parents, projects, and dependencies.
 * Rows share Listbox's row, check, group, and empty-state classes.
 */

/* Root and groups carry behavior only. */
export { Combobox, ComboboxGroup, ComboboxSeparator } from '@ui-sdk/react/combobox';

export function ComboboxLabel({ className, ...props }: ComponentProps<typeof SdkComboboxLabel>) {
  return <SdkComboboxLabel className={cn(FIELD_LABEL_CLASS, className)} {...props} />;
}

/** The filter box; it shows the chosen record once one is picked. */
export function ComboboxInput({ className, ...props }: ComponentProps<typeof SdkComboboxInput>) {
  return (
    <SdkComboboxInput
      className={cn(
        'min-h-11 w-full min-w-0 rounded-md border border-line-bright bg-well-950 py-2.5 pr-10 pl-3 text-[15px] text-ink-bright outline-none placeholder:text-ink-ghost focus-visible:border-accent data-[disabled]:opacity-50 data-[readonly]:text-ink-dim',
        className,
      )}
      {...props}
    />
  );
}

/** The chevron button at the input's end; put it in a `relative` wrapper with the input. */
export function ComboboxTrigger({
  className,
  ...props
}: Omit<ComponentProps<typeof SdkComboboxTrigger>, 'children'>) {
  return (
    <SdkComboboxTrigger
      aria-label="Show options"
      className={cn(
        'group/trigger absolute top-1/2 right-1 flex size-9 -translate-y-1/2 items-center justify-center rounded text-ink-dim outline-none hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-4 transition-transform group-data-[open]/trigger:rotate-180"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </SdkComboboxTrigger>
  );
}

/** The popup, as wide as the input. */
export function ComboboxContent({
  className,
  ...props
}: ComponentProps<typeof SdkComboboxContent>) {
  return (
    <SdkComboboxContent
      sideOffset={6}
      className={cn(
        'z-50 flex max-h-[min(320px,var(--available-height))] w-(--anchor-width) flex-col overflow-y-auto rounded-lg border border-line-bright bg-well-900 p-1.5 text-ink shadow-2xl outline-none transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

export function ComboboxList({ className, ...props }: ComponentProps<typeof SdkComboboxList>) {
  return <SdkComboboxList className={cn('flex flex-col', className)} {...props} />;
}

/** A record row; the check at its end appears while it is the chosen record. */
export function ComboboxItem<T = string>({
  className,
  children,
  ...props
}: ComboboxItemProps<T> &
  Omit<ComponentProps<'div'>, keyof ComboboxItemProps<T> | 'children'> & { children?: ReactNode }) {
  return (
    <SdkComboboxItem<T> className={cn(PICKER_ROW_CLASS, className)} {...props}>
      {children}
      <SdkComboboxItemIndicator className={PICKER_CHECK_CLASS}>
        <PickerCheck />
      </SdkComboboxItemIndicator>
    </SdkComboboxItem>
  );
}

export function ComboboxGroupLabel({
  className,
  ...props
}: ComponentProps<typeof SdkComboboxGroupLabel>) {
  return <SdkComboboxGroupLabel className={cn(PICKER_GROUP_LABEL_CLASS, className)} {...props} />;
}

export function ComboboxEmpty({
  className,
  children = 'No matches',
  ...props
}: ComponentProps<typeof SdkComboboxEmpty>) {
  return (
    <SdkComboboxEmpty className={cn(PICKER_EMPTY_CLASS, className)} {...props}>
      {children}
    </SdkComboboxEmpty>
  );
}
