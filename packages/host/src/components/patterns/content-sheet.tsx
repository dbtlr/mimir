import type { ComponentProps, ReactNode } from 'react';

import { ActionButton } from '../ui/action-button';
import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerTitle,
} from '../ui/drawer';
import type { FinalFocus } from './opener';

export type ContentSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Names the sheet: the record or row it shows, as text or with its key set in mono. */
  title: ReactNode;
  /** Where focus goes on close; a function may move focus itself and return nothing. */
  finalFocus?: FinalFocus;
  /**
   * The footer's buttons, in order; one Done that closes the sheet when none are
   * given. A button that closes it is a `ContentSheetClose`.
   */
  actions?: ReactNode;
  children: ReactNode;
};

/** A footer button that closes its Content sheet: an outline button, 44 tall. */
export function ContentSheetClose({
  children,
  ...props
}: Omit<ComponentProps<typeof ActionButton>, 'variant'>) {
  return (
    <DrawerClose render={<ActionButton variant="outline" className="min-h-11 px-4" {...props} />}>
      {children}
    </DrawerClose>
  );
}

/**
 * The Sheet surface for content (ADR 0019, MMR-736 and MMR-743): a sheet from
 * the bottom below `md`, a 440 panel from the right from `md` up, that shows a
 * record's or a row's content and settings. Its settings apply as they
 * change, so by default one Done closes it; a caller may give its own footer
 * actions. Escape and an outside press close it too. Its sides keep the Form
 * sheet's padding: 20 on a phone, 32 from `md` up (DESIGN.md, Sheets).
 */
export function ContentSheet({
  open,
  onClose,
  title,
  finalFocus,
  actions,
  children,
}: ContentSheetProps) {
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DrawerBackdrop />
      <DrawerContent
        size="content"
        finalFocus={finalFocus}
        className="gap-2 px-5 py-4 md:px-8 md:py-6"
      >
        <DrawerTitle className="text-body font-semibold text-ink-bright">{title}</DrawerTitle>
        {children}
        <DrawerFooter>{actions ?? <ContentSheetClose>Done</ContentSheetClose>}</DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
