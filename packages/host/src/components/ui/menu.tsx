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

/** Keep a key event from its default and from every listener after this one. */
function swallow(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Stop the rest of a key that chose something from reaching whatever took focus: that key's repeated
 * keydowns, its keypresses, and its keyup, until it comes up. A choice may move focus at once, as
 * opening a Destructive confirm does, and Chromium presses a focused button on Enter's keypress and
 * Space's keyup, so a held key would press the new focus over and over. No other key releases the
 * hold; window blur does, as the keyup may then never arrive, and so does a fresh press of the same
 * key. `passPress` lets the next keypress through, for a button that presses on it.
 */
function holdKey(view: Window, press: ReactKeyboardEvent, passPress: boolean) {
  const key = press.code || press.key;
  const matches = (event: KeyboardEvent) => (event.code || event.key) === key;
  let pass = passPress;
  const release = () => {
    view.removeEventListener('keydown', onKeyDown, true);
    view.removeEventListener('keypress', onKeyPress, true);
    view.removeEventListener('keyup', onKeyUp, true);
    view.removeEventListener('blur', release);
  };
  function onKeyDown(event: KeyboardEvent) {
    if (!matches(event)) {
      return;
    }
    if (event.repeat) {
      pass = false;
      swallow(event);
    } else {
      // The keyup was missed, so this is a new press.
      release();
    }
  }
  function onKeyPress(event: KeyboardEvent) {
    if (!matches(event)) {
      return;
    }
    if (pass) {
      pass = false;
    } else {
      swallow(event);
    }
  }
  function onKeyUp(event: KeyboardEvent) {
    if (matches(event)) {
      swallow(event);
      release();
    }
  }
  view.addEventListener('keydown', onKeyDown, true);
  view.addEventListener('keypress', onKeyPress, true);
  view.addEventListener('keyup', onKeyUp, true);
  view.addEventListener('blur', release);
}

/** A menu item chooses on keydown, a first press or a repeat: hold the rest of that Enter or Space. */
function holdChoosingKey(event: ReactKeyboardEvent) {
  const view = event.currentTarget.ownerDocument.defaultView;
  if (view !== null && (event.key === 'Enter' || event.key === ' ')) {
    holdKey(view, event, false);
  }
}

/**
 * For a button row that runs an action on click, such as a sheet's: Enter's keypress presses it, so
 * hold the rest of that Enter once the keypress has gone through. Space presses on keyup, after which
 * nothing of the key is left to hold. Put it on the row's `onKeyDown`.
 */
export function holdPressingEnter(event: ReactKeyboardEvent) {
  const view = event.currentTarget.ownerDocument.defaultView;
  if (view !== null && event.key === 'Enter') {
    holdKey(view, event, true);
  }
}

export function MenuItem({ className, onKeyDown, ...props }: ComponentProps<typeof SdkMenuItem>) {
  return (
    <SdkMenuItem
      className={mergeClassName(MENU_ITEM_CLASS, className)}
      onKeyDown={(event) => {
        holdChoosingKey(event);
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
