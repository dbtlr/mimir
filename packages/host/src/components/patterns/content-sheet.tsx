import type { ReactNode } from 'react';

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
  /** Names the sheet: the record or row it shows. */
  title: string;
  /** Where focus goes on close; a function may move focus itself and return nothing. */
  finalFocus?: FinalFocus;
  /** The label of the one button that closes it. */
  doneLabel?: string;
  children: ReactNode;
};

/**
 * The Sheet surface for content (ADR 0019, MMR-736): a sheet from the bottom
 * below `md`, a 440 panel from the right from `md` up, that shows a record's
 * or a row's settings and asks nothing. Its settings apply as they change, so
 * one Done closes it; Escape and an outside press close it too.
 */
export function ContentSheet({
  open,
  onClose,
  title,
  finalFocus,
  doneLabel = 'Done',
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
      <DrawerContent size="content" finalFocus={finalFocus} className="gap-2 p-4 md:p-5">
        <DrawerTitle className="text-body font-semibold text-ink-bright">{title}</DrawerTitle>
        {children}
        <DrawerFooter>
          <DrawerClose render={<ActionButton variant="outline" className="min-h-11 px-4" />}>
            {doneLabel}
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
