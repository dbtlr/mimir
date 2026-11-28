import type { ReactNode, Ref } from 'react';

import { Drawer, DrawerBackdrop, DrawerContent, DrawerTrigger } from '../ui/drawer';
import { iconButtonClass } from '../ui/icon-button';
import { MenuIcon } from '../ui/icons';

export type NavigationDrawerProps = {
  open: boolean;
  /** Runs when the drawer asks to open or close: its button, Escape, the scrim, or a drag to the edge. */
  onOpenChange: (open: boolean) => void;
  /** Runs once a close has finished, after focus has gone back to the menu button. */
  onClosed?: () => void;
  /** Names the menu button, such as "Open project menu". */
  triggerLabel: string;
  triggerRef?: Ref<HTMLButtonElement>;
  /** Names the drawer: the sidebar's landmark label. */
  label: string;
  children: ReactNode;
};

/**
 * The Navigation drawer (ADR 0019, MMR-799 refinement): the sidebar below
 * `lg`, behind the top bar's menu button. A modal Drawer from the left over
 * the scrim, 300 wide up to 88% of the viewport, on the sidebar's own
 * surface. Escape, the scrim, or a drag toward the left edge closes it and
 * hands focus back to the menu button. The caller closes it on navigation.
 */
export function NavigationDrawer({
  open,
  onOpenChange,
  onClosed,
  triggerLabel,
  triggerRef,
  label,
  children,
}: NavigationDrawerProps) {
  return (
    <Drawer
      side="left"
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) {
          onClosed?.();
        }
      }}
    >
      <DrawerTrigger ref={triggerRef} aria-label={triggerLabel} className={iconButtonClass}>
        <MenuIcon />
      </DrawerTrigger>
      <DrawerBackdrop data-testid="navigation-drawer-scrim" />
      <DrawerContent size="navigation" aria-label={label}>
        {children}
      </DrawerContent>
    </Drawer>
  );
}
