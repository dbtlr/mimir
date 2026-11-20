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
import type { ComponentProps, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { mergeClassName } from './class-name';
import { LIST_DIVIDER_CLASS } from './separator';

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
      className={mergeClassName(PANEL_CLASS, className)}
      {...props}
    />
  );
}

/**
 * Stop the rest of the key that chose an item from reaching whatever took focus. The menu chooses on
 * keydown, and an item's action may move focus at once, as opening a Destructive confirm does; the
 * same key's keypress and keyup then reach the new focus, and Chromium presses a focused button on
 * Enter's keypress and Space's keyup. Held until that key comes up, another key goes down, or the
 * window loses focus.
 */
function holdKeyTail(chosen: ReactKeyboardEvent) {
  const { key } = chosen;
  if ((key !== 'Enter' && key !== ' ') || chosen.repeat) {
    return;
  }
  const view = chosen.currentTarget.ownerDocument.defaultView;
  if (view === null) {
    return;
  }
  const release = () => {
    view.removeEventListener('keypress', swallow, true);
    view.removeEventListener('keyup', swallow, true);
    view.removeEventListener('keydown', next, true);
    view.removeEventListener('blur', release);
  };
  function swallow(event: KeyboardEvent) {
    if (event.key !== key) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'keyup') {
      release();
    }
  }
  function next(event: KeyboardEvent) {
    if (!event.repeat) {
      release();
    }
  }
  view.addEventListener('keypress', swallow, true);
  view.addEventListener('keyup', swallow, true);
  view.addEventListener('keydown', next, true);
  view.addEventListener('blur', release);
}

export function MenuItem({ className, onKeyDown, ...props }: ComponentProps<typeof SdkMenuItem>) {
  return (
    <SdkMenuItem
      className={mergeClassName(MENU_ITEM_CLASS, className)}
      onKeyDown={(event) => {
        holdKeyTail(event);
        onKeyDown?.(event);
      }}
      {...props}
    />
  );
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof SdkMenuSeparator>) {
  return <SdkMenuSeparator className={mergeClassName(LIST_DIVIDER_CLASS, className)} {...props} />;
}

export function MenuGroupLabel({ className, ...props }: ComponentProps<typeof SdkMenuGroupLabel>) {
  return (
    <SdkMenuGroupLabel
      className={mergeClassName('microlabel px-2 py-1 text-ink-faint', className)}
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
      className={mergeClassName(
        MENU_ITEM_CLASS,
        'justify-between data-[open]:bg-line-bright',
        className,
      )}
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
  return <SdkMenuSubContent className={mergeClassName(PANEL_CLASS, className)} {...props} />;
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
    <SdkMenuRadioItem className={mergeClassName(MENU_ITEM_CLASS, className)} {...props}>
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
    <SdkMenuCheckboxItem className={mergeClassName(MENU_ITEM_CLASS, className)} {...props}>
      <MenuCheck />
      {children}
    </SdkMenuCheckboxItem>
  );
}
