import { Popover } from '@base-ui-components/react/popover';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../../lib/cn';

/**
 * Vendored Base UI popover — a non-modal panel anchored to its trigger, for
 * content that holds controls of its own (the top-bar Needs you list). Use
 * the menu for a list of commands. Focus moves in on open, and Escape closes
 * and returns it to the trigger.
 */
export function PopoverRoot(props: ComponentProps<typeof Popover.Root>) {
  return <Popover.Root {...props} />;
}

export function PopoverTrigger(props: ComponentProps<typeof Popover.Trigger>) {
  return <Popover.Trigger {...props} />;
}

export function PopoverContent({
  className,
  children,
  ...props
}: ComponentProps<typeof Popover.Popup> & { children: ReactNode }) {
  return (
    <Popover.Portal>
      <Popover.Positioner align="end" sideOffset={8} className="z-50">
        <Popover.Popup
          className={cn(
            'flex max-h-[min(70dvh,640px)] w-[min(440px,calc(100vw-2rem))] flex-col rounded-lg border border-line-bright bg-well-900 shadow-2xl outline-none',
            className,
          )}
          {...props}
        >
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}
