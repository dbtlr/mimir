import { cloneElement, useState } from 'react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { useMediaQuery } from '../../lib/use-media-query';
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
import { Separator } from '../ui/separator';

/*
 * Action menu (ADR 0019, MMR-736): use it for a list of actions, including a
 * record's More, and for the one Choice a list may hold (the theme, as menu
 * radio items). From `md` up it is a menu anchored to its trigger; below `md`
 * it is a bottom Sheet with 44px rows and a Cancel row. The pattern makes that switch, so no
 * feature builds both. A plain action closes it; a radio item keeps it open.
 * Focus returns to the trigger on close, unless the action sets `movesFocus`
 * because it sends focus somewhere on purpose, such as a Destructive confirm.
 */

/** What a custom row receives: the pattern's class, its press handler, and the label. */
type RowProps = { className?: string; onClick?: () => void; children?: ReactNode };

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
  /** The action moves focus itself (it opens a confirm): the menu does not return it. */
  movesFocus?: boolean;
  /** An element that is the row, such as a router `<Link>`; it receives the label. */
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
  const desktop = useMediaQuery(DRAWER_DESKTOP_QUERY);
  const [own, setOwn] = useState(false);
  // Set by an action that moves focus on purpose; cleared when the menu next opens.
  const [movedFocus, setMovedFocus] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => {
    if (next) {
      setMovedFocus(false);
    }
    setOwn(next);
    onOpenChange?.(next);
  };
  const finalFocus = movedFocus ? 'none' : (given ?? 'trigger');
  const choose = (action: ActionMenuAction) => {
    if (action.movesFocus === true) {
      setMovedFocus(true);
    }
    action.onSelect?.();
    if (action.keepOpen !== true) {
      setOpen(false);
    }
  };

  if (desktop) {
    return (
      <Menu open={open} onOpenChange={(next) => setOpen(next)}>
        <MenuTrigger render={trigger} />
        <MenuContent aria-label={title} finalFocus={finalFocus} className={menuClassName}>
          {entries.map((entry) => (
            <MenuEntry key={entry.key} entry={entry} onChoose={choose} />
          ))}
        </MenuContent>
      </Menu>
    );
  }
  return (
    <Drawer side="bottom" open={open} onOpenChange={(next) => setOpen(next)}>
      <DrawerTrigger render={trigger} />
      <DrawerBackdrop />
      <DrawerContent finalFocus={finalFocus} className="gap-1 p-3">
        <div className="px-3 pb-2">
          <DrawerTitle>{title}</DrawerTitle>
          {description !== undefined && <DrawerDescription>{description}</DrawerDescription>}
        </div>
        {entries.map((entry) => (
          <SheetEntry key={entry.key} entry={entry} onChoose={choose} />
        ))}
        <DrawerClose
          render={<CancelRow />}
          className={cn(MENU_ITEM_CLASS, 'min-h-11 text-ink-dim')}
        >
          Cancel
        </DrawerClose>
      </DrawerContent>
    </Drawer>
  );
}

/** The sheet's Cancel row; DrawerClose gives it its label. */
function CancelRow(props: ComponentProps<'button'>) {
  return <button type="button" {...props} />;
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
      render={entry.render}
      disabled={entry.disabled}
      destructive={entry.destructive}
      closeOnSelect={entry.keepOpen === true ? false : undefined}
      className={entry.className}
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
    return (
      <div role="radiogroup" aria-label={entry.label} className="flex flex-col">
        <p className="microlabel px-2 py-1 text-ink-faint">{entry.label}</p>
        {entry.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === entry.value}
            className={cn(MENU_ITEM_CLASS, 'min-h-11')}
            onClick={() => {
              entry.onChange(option.value);
            }}
          >
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex size-4 shrink-0 items-center justify-center',
                option.value !== entry.value && 'invisible',
              )}
            >
              ✓
            </span>
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    );
  }
  const className = cn(
    MENU_ITEM_CLASS,
    'min-h-11',
    entry.destructive === true && 'text-status-blocked-foreground',
    entry.className,
  );
  const onClick = () => {
    if (entry.disabled !== true) {
      onChoose(entry);
    }
  };
  const content = (
    <>
      {entry.icon}
      {entry.label}
    </>
  );
  if (entry.render !== undefined) {
    return cloneElement(entry.render, {
      children: content,
      className,
      onClick,
    });
  }
  return (
    <button
      type="button"
      className={className}
      disabled={entry.disabled}
      data-disabled={entry.disabled === true ? '' : undefined}
      onClick={onClick}
    >
      {content}
    </button>
  );
}
