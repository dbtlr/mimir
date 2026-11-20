import {
  MenuContent as SdkMenuContent,
  MenuGroupLabel as SdkMenuGroupLabel,
  MenuCheckboxItem as SdkMenuCheckboxItem,
  MenuItem as SdkMenuItem,
  MenuItemIndicator as SdkMenuItemIndicator,
  MenuRadioItem as SdkMenuRadioItem,
  MenuSeparator as SdkMenuSeparator,
  MenuSubContent as SdkMenuSubContent,
  MenuSubTrigger as SdkMenuSubTrigger,
} from '@ui-sdk/react/menu';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { SEPARATOR_CLASS } from './separator';

/*
 * The Menu primitive (ADR 0046): the desktop Action menu, a list of commands
 * off a trigger. A destructive item reads in the blocked colour (ADR 0019,
 * MMR-635); the highlighted item is a filled row, so state reads without
 * colour alone. Use Popover for content that holds controls of its own.
 */

/* Root, Trigger, Group, and Sub carry behavior only. */
export { Menu, MenuGroup, MenuRadioGroup, MenuSub, MenuTrigger } from '@ui-sdk/react/menu';

const PANEL_CLASS =
  'z-50 min-w-36 origin-(--transform-origin) rounded-md border border-line-bright bg-well-800 p-1 text-ink shadow-xl outline-none transition-[opacity,scale] duration-100 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0';

/** One row: highlight fill, destructive colour, and a disabled state that still reads. */
export const MENU_ITEM_CLASS =
  'flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-2.5 text-left text-sm text-ink outline-none select-none max-md:min-h-11 md:py-1.5 md:text-xs data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-faint data-[highlighted]:bg-line-bright data-[highlighted]:text-ink-bright data-[destructive]:text-status-blocked-foreground data-[destructive]:data-[highlighted]:text-status-blocked-foreground';

export function MenuContent({
  className,
  align = 'end',
  sideOffset = 4,
  ...props
}: ComponentProps<typeof SdkMenuContent>) {
  return (
    <SdkMenuContent
      align={align}
      sideOffset={sideOffset}
      className={cn(PANEL_CLASS, className)}
      {...props}
    />
  );
}

export function MenuItem({ className, ...props }: ComponentProps<typeof SdkMenuItem>) {
  return <SdkMenuItem className={cn(MENU_ITEM_CLASS, className)} {...props} />;
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof SdkMenuSeparator>) {
  return <SdkMenuSeparator className={cn(SEPARATOR_CLASS, 'my-1', className)} {...props} />;
}

export function MenuGroupLabel({ className, ...props }: ComponentProps<typeof SdkMenuGroupLabel>) {
  return (
    <SdkMenuGroupLabel
      className={cn('microlabel px-2 py-1 text-ink-faint', className)}
      {...props}
    />
  );
}

/** Opens a submenu; draws its own chevron because web.css is not loaded. */
export function MenuSubTrigger({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof SdkMenuSubTrigger>, 'children'> & { children?: ReactNode }) {
  return (
    <SdkMenuSubTrigger
      className={cn(MENU_ITEM_CLASS, 'justify-between data-[open]:bg-line-bright', className)}
      {...props}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-3.5 shrink-0 text-ink-dim"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </SdkMenuSubTrigger>
  );
}

export function MenuSubContent({ className, ...props }: ComponentProps<typeof SdkMenuSubContent>) {
  return <SdkMenuSubContent className={cn(PANEL_CLASS, className)} {...props} />;
}

/** A fixed slot at the row's start so labels align whether or not the row is checked. */
function MenuCheck() {
  return (
    <SdkMenuItemIndicator
      keepMounted
      className="inline-flex size-4 shrink-0 items-center justify-center data-[unchecked]:invisible"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m5 12 5 5L20 7" />
      </svg>
    </SdkMenuItemIndicator>
  );
}

/** One choice in a MenuRadioGroup; the check shows which is chosen (ADR 0019 Choice in an Action menu). */
export function MenuRadioItem({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof SdkMenuRadioItem>, 'children'> & { children?: ReactNode }) {
  return (
    <SdkMenuRadioItem className={cn(MENU_ITEM_CLASS, className)} {...props}>
      <MenuCheck />
      {children}
    </SdkMenuRadioItem>
  );
}

/** A toggle row that stays open; the check shows it is on. */
export function MenuCheckboxItem({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof SdkMenuCheckboxItem>, 'children'> & { children?: ReactNode }) {
  return (
    <SdkMenuCheckboxItem className={cn(MENU_ITEM_CLASS, className)} {...props}>
      <MenuCheck />
      {children}
    </SdkMenuCheckboxItem>
  );
}
