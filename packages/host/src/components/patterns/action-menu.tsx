import { cloneElement, useId, useLayoutEffect, useRef, useState } from 'react';
import type {
  ComponentProps,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from 'react';

import { cn } from '../../lib/cn';
import { focusMain } from '../../lib/focus-main';
import { useMediaQuery } from '../../lib/use-media-query';
import { DESTRUCTIVE_OUTLINE } from '../ui/action-button';
import {
  Drawer,
  DRAWER_DESKTOP_QUERY,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from '../ui/drawer';
import {
  holdPressingEnter,
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MENU_ITEM_CLASS,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '../ui/menu';
import { Radio, RadioGroup } from '../ui/radio';
import { Separator } from '../ui/separator';
import { reachable, tabSequence } from './feed/tab-order';

/*
 * Action menu (ADR 0019, MMR-736): use it for a list of actions, including a
 * record's More, and for the one Choice a list may hold (the theme, as menu
 * radio items). From `md` up it is a menu anchored to its trigger; below `md`
 * it is a bottom Sheet with 44px rows and a Cancel row, its top edge the sheet seam. The pattern makes that switch, so no
 * feature builds both. A plain action closes it; a radio item keeps it open.
 * Focus returns to the trigger on close. When the row holding the menu leaves,
 * at once or after a refetch, and the caller passed no `finalFocus`, focus
 * moves on to the next control on the page, else the page's `<main>`, never
 * body (MMR-767); an action that opens a confirm needs
 * nothing more, as the confirm takes focus from the trigger and gives it back.
 * The rest of a key that chose a row (its repeats, keypress, and keyup) is held
 * until it comes up, so it never presses what took focus.
 * A destructive action wears the MMR-635 red hairline in both shapes.
 */

/**
 * From this width up the Action menu is anchored to its trigger; below it, a
 * bottom Sheet. A caller whose trigger changes shape with the width, such as a
 * full-width row on a phone, switches at this query so the two agree.
 */
export const ACTION_MENU_ANCHORED_QUERY = DRAWER_DESKTOP_QUERY;

/**
 * Marks a row whose action closes the menu, so a surface holding the menu can
 * tell the menu's own choice from its other controls (its Cancel row, a Choice):
 * a record's chip sheet closes on the first, as on any other choice inside it.
 */
export const CLOSING_ROW_ATTRIBUTE = 'data-closes-menu';

/** What a custom row receives: the pattern's class, its press handler, and the label. */
type RowProps = {
  className?: string;
  href?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  children?: ReactNode;
  'aria-disabled'?: boolean | 'true' | 'false';
};

const SHEET_ROW_CLASS = cn(
  MENU_ITEM_CLASS,
  'min-h-11 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent',
);

/** The hairline row of an action that ends or removes something (ADR 0019, MMR-635). */
const DESTRUCTIVE_ROW = cn(
  DESTRUCTIVE_OUTLINE,
  'data-[highlighted]:bg-line/50 data-[highlighted]:text-status-blocked-foreground',
);

export type ActionMenuAction = {
  kind: 'action';
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  /** Reads in the blocked colour: it ends or removes something. */
  destructive?: boolean;
  /** Stay open after the action runs, as an update check does. */
  keepOpen?: boolean;
  /** An element that is the row, such as a router `<Link>`; it receives the label, and keeps its own class and press handler. */
  render?: ReactElement<RowProps>;
  className?: string;
};

export type ActionMenuChoice = {
  kind: 'choice';
  key: string;
  /** The group's name. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: ReactNode; icon?: ReactNode }[];
};

export type ActionMenuEntry =
  | ActionMenuAction
  | ActionMenuChoice
  | { kind: 'separator'; key: string };

export type ActionMenuProps = {
  /** The control that opens it: an element that takes a ref and props, such as a `<button>`. */
  trigger: ReactElement;
  /** Names the menu, and heads the sheet. */
  title: string;
  /** A line under the sheet's title. */
  description?: ReactNode;
  entries: ActionMenuEntry[];
  /** Pass `open` to control it, for a caller that closes it itself. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  menuClassName?: string;
  /** Where focus goes on close, for a trigger that may be gone by then. The default is the trigger. */
  finalFocus?: () => HTMLElement | null;
};

export function ActionMenu({
  trigger,
  title,
  description,
  entries,
  open: controlled,
  onOpenChange,
  menuClassName,
  finalFocus: given,
}: ActionMenuProps) {
  const desktop = useMediaQuery(ACTION_MENU_ANCHORED_QUERY);
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  const finalFocus = given ?? 'trigger';
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useFocusOnWhenRemoved(triggerRef, contentRef, given === undefined);
  const choose = (action: ActionMenuAction) => {
    action.onSelect?.();
    if (action.keepOpen !== true) {
      setOpen(false);
    }
  };

  if (desktop) {
    return (
      <Menu open={open} onOpenChange={(next) => setOpen(next)}>
        <MenuTrigger ref={triggerRef} render={trigger} />
        <MenuContent
          ref={contentRef}
          aria-label={title}
          finalFocus={finalFocus}
          className={menuClassName}
        >
          {entries.map((entry) => (
            <MenuEntry key={entry.key} entry={entry} onChoose={choose} />
          ))}
        </MenuContent>
      </Menu>
    );
  }
  return (
    <Drawer side="bottom" open={open} onOpenChange={(next) => setOpen(next)}>
      <DrawerTrigger ref={triggerRef} render={trigger} />
      <DrawerBackdrop />
      <DrawerContent
        ref={contentRef}
        finalFocus={finalFocus}
        className="gap-1 border-sheet-seam p-3 light:elevation-sheet-up"
      >
        <div className="px-3 pb-2">
          <DrawerTitle>{title}</DrawerTitle>
          {description !== undefined && <DrawerDescription>{description}</DrawerDescription>}
        </div>
        {entries.map((entry) => (
          <SheetEntry key={entry.key} entry={entry} onChoose={choose} />
        ))}
        <DrawerClose render={<CancelRow />} className={cn(SHEET_ROW_CLASS, 'text-ink-dim')}>
          Cancel
        </DrawerClose>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * When the menu unmounts holding focus, on its trigger or inside it (its row
 * left), and focus then sits on body, moves focus to the next control Tab
 * would have reached that is still on the page and can still take focus,
 * else `<main>` (MMR-767).
 * Off (`active` false) when the caller passes its own `finalFocus`.
 */
function useFocusOnWhenRemoved(
  trigger: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useLayoutEffect(
    () => () => {
      const from = trigger.current;
      if (!active) {
        return;
      }
      const focused = document.activeElement;
      if (from === null || (focused !== from && content.current?.contains(focused) !== true)) {
        return;
      }
      // Read now, while the leaving row is still in the document to say where it was.
      const after = tabSequence(document).filter(
        (element) =>
          (from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      );
      queueMicrotask(() => {
        if (document.activeElement !== null && document.activeElement !== document.body) {
          return;
        }
        // A control can be disabled or hidden after the read; it must still take focus now.
        const next = after.find((element) => element.isConnected && reachable(element));
        if (next === undefined) {
          focusMain();
        } else {
          next.focus();
        }
      });
    },
    [trigger, content, active],
  );
}

/** The sheet's Cancel row; DrawerClose gives it its label. */
function CancelRow({ onKeyDown, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      onKeyDown={(event) => {
        holdPressingEnter(event);
        onKeyDown?.(event);
      }}
      {...props}
    />
  );
}

/** The closing-row mark for an action that closes the menu when chosen. */
const closingRow = (entry: ActionMenuAction) =>
  entry.disabled === true || entry.keepOpen === true ? {} : { [CLOSING_ROW_ATTRIBUTE]: '' };

function customRow(entry: ActionMenuAction): ReactElement<RowProps> | undefined {
  const row = entry.render;
  if (row === undefined || entry.disabled !== true) {
    return row;
  }
  // A disabled link has no href, so it names its role itself to stay announced as a link.
  // A component such as a router Link can generate an href from its other props.
  if (typeof row.type !== 'string') {
    // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the pattern gives the row its label
    return <span className={row.props.className} role="link" />;
  }
  return cloneElement(row, {
    href: undefined,
    onClick: undefined,
    onKeyDown: undefined,
    ...(row.type === 'a' ? { role: 'link' } : {}),
  });
}

function MenuEntry({
  entry,
  onChoose,
}: {
  entry: ActionMenuEntry;
  onChoose: (action: ActionMenuAction) => void;
}) {
  if (entry.kind === 'separator') {
    return <MenuSeparator />;
  }
  if (entry.kind === 'choice') {
    return (
      <MenuGroup>
        <MenuGroupLabel>{entry.label}</MenuGroupLabel>
        <MenuRadioGroup value={entry.value} onValueChange={(value) => entry.onChange(value)}>
          {entry.options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              {option.icon}
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
    );
  }
  return (
    <MenuItem
      render={customRow(entry)}
      disabled={entry.disabled}
      destructive={entry.destructive}
      closeOnSelect={entry.keepOpen === true ? false : undefined}
      {...closingRow(entry)}
      className={cn(entry.destructive === true && DESTRUCTIVE_ROW, entry.className)}
      onClick={(event) => {
        // A disabled link row stays where it is.
        if (entry.disabled === true) {
          event.preventDefault();
        }
      }}
      onSelect={() => {
        // The menu closes itself on select, so `keepOpen` here only stops a second close report.
        onChoose({ ...entry, keepOpen: true });
      }}
    >
      {entry.icon}
      {entry.label}
    </MenuItem>
  );
}

function SheetEntry({
  entry,
  onChoose,
}: {
  entry: ActionMenuEntry;
  onChoose: (action: ActionMenuAction) => void;
}) {
  if (entry.kind === 'separator') {
    return <Separator className="my-1" />;
  }
  if (entry.kind === 'choice') {
    return <SheetChoice choice={entry} />;
  }
  const className = cn(
    SHEET_ROW_CLASS,
    entry.destructive === true && DESTRUCTIVE_ROW,
    entry.className,
  );
  const content = (
    <>
      {entry.icon}
      {entry.label}
    </>
  );
  const row = customRow(entry);
  if (row !== undefined) {
    const own = row.props;
    return cloneElement(row, {
      ...closingRow(entry),
      'aria-disabled': entry.disabled === true ? true : own['aria-disabled'],
      children: content,
      className: cn(className, own.className),
      onClick: (event: MouseEvent<HTMLElement>) => {
        // A disabled link row stays where it is and runs nothing.
        if (entry.disabled === true) {
          event.preventDefault();
          return;
        }
        own.onClick?.(event);
        onChoose(entry);
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (entry.disabled === true) {
          return;
        }
        holdPressingEnter(event);
        own.onKeyDown?.(event);
      },
    });
  }
  const onClick = () => {
    if (entry.disabled !== true) {
      onChoose(entry);
    }
  };
  return (
    <button
      type="button"
      className={className}
      disabled={entry.disabled}
      data-disabled={entry.disabled === true ? '' : undefined}
      {...closingRow(entry)}
      onKeyDown={holdPressingEnter}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

/** The sheet's one Choice: a radio group, one tab stop whose arrow keys move the choice. It keeps the sheet open. */
function SheetChoice({ choice }: { choice: ActionMenuChoice }) {
  const labelId = useId();
  return (
    <div className="flex flex-col">
      <p id={labelId} className="microlabel px-2 py-1 text-ink-dim">
        {choice.label}
      </p>
      <RadioGroup
        aria-labelledby={labelId}
        value={choice.value}
        onValueChange={(value) => {
          if (typeof value === 'string') {
            choice.onChange(value);
          }
        }}
        className="flex flex-col"
      >
        {choice.options.map((option) => (
          <label key={option.value} className={cn(MENU_ITEM_CLASS, 'min-h-11 cursor-pointer')}>
            <Radio value={option.value} />
            {option.icon}
            {option.label}
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}
