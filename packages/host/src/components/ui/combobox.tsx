import {
  ComboboxChip as SdkComboboxChip,
  ComboboxChipRemove as SdkComboboxChipRemove,
  ComboboxChips as SdkComboboxChips,
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

import { mergeClassName } from './class-name';
import { FIELD_LABEL_CLASS } from './field';
import { CONTROL_EDGE_CLASS, TEXT_FIELD_CLASS } from './input';
import {
  PICKER_CHECK_CLASS,
  PICKER_EMPTY_CLASS,
  PICKER_GROUP_LABEL_CLASS,
  PICKER_ROW_CLASS,
  PickerCheck,
} from './listbox';
import { CHIP_CLASS, CHIP_REMOVE_CLASS, ChipRemoveIcon } from './token-input';

/*
 * The Combobox primitive (ADR 0046): an input that filters a popup list of
 * records and picks one. It is the engine of the Record picker pattern (ADR
 * 0019, MMR-736), which composes it for parents, projects, and dependencies.
 * Rows share Listbox's row, check, group, and empty-state classes.
 */

/* Root and groups carry behavior only. */
export { Combobox, ComboboxGroup, ComboboxSeparator, ComboboxValue } from '@ui-sdk/react/combobox';

export function ComboboxLabel({ className, ...props }: ComponentProps<typeof SdkComboboxLabel>) {
  return <SdkComboboxLabel className={mergeClassName(FIELD_LABEL_CLASS, className)} {...props} />;
}

/** The filter box; it shows the chosen record once one is picked. */
export function ComboboxInput({ className, ...props }: ComponentProps<typeof SdkComboboxInput>) {
  return (
    <SdkComboboxInput
      className={mergeClassName(TEXT_FIELD_CLASS, 'min-h-11 min-w-0 py-2.5 pr-10', className)}
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
      className={mergeClassName(
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

/**
 * A trigger that is the field itself: a 44px control showing the chosen record
 * and a chevron, which opens a popup holding the filter input ("Input in the
 * Popup"). A Record picker in a form uses it, so its value can set a key in
 * mono beside a title in sans, which an input cannot.
 */
export function ComboboxButton({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof SdkComboboxTrigger>, 'children'> & { children?: ReactNode }) {
  return (
    <SdkComboboxTrigger
      className={mergeClassName(
        CONTROL_EDGE_CLASS,
        'inline-flex h-11 w-full min-w-0 items-center justify-between gap-3 px-3 text-left data-[open]:border-accent data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children}</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-3.5 shrink-0 text-ink-dim"
      >
        <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
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
      className={mergeClassName(
        'z-50 flex max-h-[min(320px,var(--available-height))] w-(--anchor-width) flex-col overflow-y-auto rounded-lg border border-line-bright bg-well-900 p-1.5 text-ink shadow-2xl outline-none transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

export function ComboboxList({ className, ...props }: ComponentProps<typeof SdkComboboxList>) {
  return <SdkComboboxList className={mergeClassName('flex flex-col', className)} {...props} />;
}

/** A record row; the check at its end appears while it is the chosen record. */
export function ComboboxItem<T = string>({
  className,
  children,
  ...props
}: ComboboxItemProps<T> &
  Omit<ComponentProps<'div'>, keyof ComboboxItemProps<T> | 'children'> & { children?: ReactNode }) {
  return (
    <SdkComboboxItem<T> className={mergeClassName(PICKER_ROW_CLASS, className)} {...props}>
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
  return (
    <SdkComboboxGroupLabel
      className={mergeClassName(PICKER_GROUP_LABEL_CLASS, className)}
      {...props}
    />
  );
}

export function ComboboxEmpty({
  className,
  children = 'No matches',
  ...props
}: ComponentProps<typeof SdkComboboxEmpty>) {
  return (
    <SdkComboboxEmpty className={mergeClassName(PICKER_EMPTY_CLASS, className)} {...props}>
      {children}
    </SdkComboboxEmpty>
  );
}

/**
 * The box that holds the chosen chips and the filter input of a `multiple`
 * Combobox. It takes the text-box look, and its edge follows the input's focus
 * and invalid state.
 */
export function ComboboxChips({ className, ...props }: ComponentProps<typeof SdkComboboxChips>) {
  return (
    <SdkComboboxChips
      className={mergeClassName(
        TEXT_FIELD_CLASS,
        'flex min-h-11 flex-wrap items-center gap-y-1 py-1.5 pr-10 focus-within:border-accent has-[[aria-invalid=true]]:border-status-blocked',
        className,
      )}
      {...props}
    />
  );
}

/** The filter input inside ComboboxChips; the box draws the edge, so it has none. */
export function ComboboxChipsInput({
  className,
  ...props
}: ComponentProps<typeof SdkComboboxInput>) {
  return (
    <SdkComboboxInput
      className={mergeClassName(
        'min-w-24 flex-1 bg-transparent py-1 text-[15px] text-ink-bright outline-none placeholder:text-ink-ghost data-[disabled]:cursor-not-allowed',
        className,
      )}
      {...props}
    />
  );
}

/** A chosen record, in the chip look Token Input uses. */
export function ComboboxChip({ className, ...props }: ComponentProps<typeof SdkComboboxChip>) {
  return <SdkComboboxChip className={mergeClassName(CHIP_CLASS, className)} {...props} />;
}

/** The chip's remove button; pass an `aria-label` naming the record. */
export function ComboboxChipRemove({
  className,
  ...props
}: Omit<ComponentProps<typeof SdkComboboxChipRemove>, 'children'>) {
  return (
    <SdkComboboxChipRemove className={mergeClassName(CHIP_REMOVE_CLASS, className)} {...props}>
      <ChipRemoveIcon />
    </SdkComboboxChipRemove>
  );
}
