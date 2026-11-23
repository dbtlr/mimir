import {
  Select as SdkSelect,
  SelectContent as SdkSelectContent,
  SelectGroupLabel as SdkSelectGroupLabel,
  SelectItem as SdkSelectItem,
  SelectItemIndicator,
  SelectList,
  SelectSeparator as SdkSelectSeparator,
  SelectTrigger as SdkSelectTrigger,
  SelectValue,
} from '@ui-sdk/react/select';
import type { SelectProps } from '@ui-sdk/react/select';
import type { ComponentProps, ReactNode } from 'react';

import { useMediaQuery } from '../../lib/use-media-query';
import { mergeClassName } from './class-name';
import { DRAWER_DESKTOP_QUERY } from './drawer';
import { CONTROL_EDGE_CLASS } from './input';
import { LIST_DIVIDER_CLASS } from './separator';

/*
 * The Select primitive (ADR 0046): UI SDK's select in the Meridian look. A
 * Select holds a longer fixed list, such as T3's models or a sort order (ADR
 * 0019, MMR-736). Its trigger is a 44px control that shares the text box's
 * edge, so a form's controls end on one height and one edge (DESIGN.md,
 * Sizes). From `md` up the list is a menu 8 below the trigger; below `md` it is
 * a bottom list over the scrim, headed by the field's label, so it never lands
 * over the next fields. The trigger and the selected item's check are drawn
 * here because UI SDK's own icons ship only in its stylesheet.
 */
export { SelectGroup } from '@ui-sdk/react/select';

const ICON_PROPS = {
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  strokeWidth: 2,
  viewBox: '0 0 12 12',
} as const;

/** The root; it presents its list as a bottom sheet below `md`. */
export function Select<T = string>(props: SelectProps<T>) {
  const desktop = useMediaQuery(DRAWER_DESKTOP_QUERY);
  return <SdkSelect<T> presentation={desktop ? 'popover' : 'sheet'} {...props} />;
}

/** The closed control: the selected label (or the placeholder) and a chevron. */
export function SelectTrigger({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof SdkSelectTrigger>, 'children'> & {
  /** What the closed control shows for the value; the selected item's text by default. */
  children?: ReactNode;
}) {
  return (
    <SdkSelectTrigger
      className={mergeClassName(
        CONTROL_EDGE_CLASS,
        'inline-flex h-11 min-w-44 items-center justify-between gap-3 px-3 text-left',
        'data-[placeholder]:text-ink-dim data-[open]:border-accent data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children ?? <SelectValue />}</span>
      <svg {...ICON_PROPS} className="size-3.5 shrink-0 text-ink-dim">
        <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
      </svg>
    </SdkSelectTrigger>
  );
}

/*
 * The open list. As a menu over a sheet it is well-800 with an ink-faint edge,
 * so it reads above a well-850 panel; as a phone's bottom list it is well-850
 * with a 12 top radius, a seam that meets 3:1 against the scrim, and the
 * home-indicator inset below its last row (DESIGN.md, Radii).
 */
const CONTENT_CLASS = [
  'group/select z-50 flex flex-col text-ink outline-none transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0',
  'data-[presentation=popover]:max-h-(--available-height) data-[presentation=popover]:min-w-(--anchor-width) data-[presentation=popover]:rounded-lg data-[presentation=popover]:border data-[presentation=popover]:border-ink-faint data-[presentation=popover]:bg-well-800 data-[presentation=popover]:p-1 data-[presentation=popover]:light:shadow-menu',
  'data-[presentation=sheet]:max-h-[calc(100dvh-env(safe-area-inset-top)-64px)] data-[presentation=sheet]:w-full data-[presentation=sheet]:rounded-t-xl data-[presentation=sheet]:border-t data-[presentation=sheet]:border-sheet-seam data-[presentation=sheet]:bg-well-850 data-[presentation=sheet]:px-2 data-[presentation=sheet]:pt-2 data-[presentation=sheet]:elevation-sheet-up data-[presentation=sheet]:[--sheet-backdrop:color-mix(in_srgb,var(--color-well-950)_70%,transparent)]',
].join(' ');

/**
 * The popup list, as wide as its trigger at least. `label` heads it as a
 * phone's bottom list; pass the field's label.
 */
export function SelectContent({
  className,
  children,
  label,
  ...props
}: ComponentProps<typeof SdkSelectContent> & { label?: string }) {
  return (
    <SdkSelectContent
      sideOffset={8}
      className={mergeClassName(CONTENT_CLASS, className)}
      {...props}
    >
      <div
        aria-hidden="true"
        className="mx-auto mb-4 hidden h-1 w-9 shrink-0 rounded-full bg-ink-faint group-data-[presentation=sheet]/select:block"
      />
      {label !== undefined && (
        <div
          aria-hidden="true"
          className="hidden shrink-0 px-3 pb-2 text-base leading-6 font-semibold text-ink-bright group-data-[presentation=sheet]/select:block"
        >
          {label}
        </div>
      )}
      <SelectList className="min-h-0 flex-1 overflow-y-auto group-data-[presentation=sheet]/select:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {children}
      </SelectList>
    </SdkSelectContent>
  );
}

/** A group's name inside the open list ("Claude" over its models): 13/20 ink-dim at 500. */
export function SelectGroupLabel({
  className,
  ...props
}: ComponentProps<typeof SdkSelectGroupLabel>) {
  return (
    <SdkSelectGroupLabel
      className={mergeClassName(
        'px-3 pt-2 pb-1 text-meta leading-5 font-medium text-ink-dim [[role=group]+[role=group]_&]:pt-3',
        className,
      )}
      {...props}
    />
  );
}

/**
 * One choice: 36 tall on a desktop, 44 on a phone; the chosen row carries a
 * check. In a phone's bottom list a pointer never highlights a row, so the list
 * opens with the tick alone marking the chosen one.
 */
export function SelectItem({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof SdkSelectItem>, 'children'> & { children: ReactNode }) {
  return (
    <SdkSelectItem
      className={mergeClassName(
        'flex min-h-9 cursor-default items-center justify-between gap-3 rounded-md px-3 text-[15px] leading-[22px] text-ink outline-none select-none group-data-[presentation=sheet]/select:min-h-11',
        'data-[highlighted]:bg-line data-[highlighted]:text-ink-bright data-[selected]:text-ink-bright',
        // A phone's bottom list opened by a tap marks the chosen row with its tick alone; the
        // highlight is for the keyboard there, and a press shows as the row is held.
        'group-data-[presentation=sheet]/select:group-data-[modality=pointer]/select:data-[highlighted]:bg-transparent group-data-[presentation=sheet]/select:active:bg-line',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children}</span>
      <SelectItemIndicator className="text-accent-foreground">
        <svg {...ICON_PROPS} className="size-3.5">
          <path d="M2.5 6.5 5 9l4.5-5.5" />
        </svg>
      </SelectItemIndicator>
    </SdkSelectItem>
  );
}

/** A hairline between groups of choices, where no group heading sets them off. */
export function SelectSeparator({
  className,
  ...props
}: ComponentProps<typeof SdkSelectSeparator>) {
  return (
    <SdkSelectSeparator className={mergeClassName(LIST_DIVIDER_CLASS, className)} {...props} />
  );
}
