import { Dialog } from "@base-ui-components/react/dialog";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Vendored shadcn-style sheet over the Base UI dialog — the node-detail
 * drawer: right-anchored on desktop, bottom-anchored on small screens.
 */
export function Sheet(props: ComponentProps<typeof Dialog.Root>) {
  return <Dialog.Root {...props} />;
}

export function SheetContent({
  className,
  children,
  ...props
}: ComponentProps<typeof Dialog.Popup> & { children: ReactNode }) {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-well-950/70 backdrop-blur-[2px] transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
      <Dialog.Popup
        className={cn(
          "fixed z-50 flex flex-col border-line bg-well-900 shadow-2xl outline-none transition-transform duration-200 ease-out",
          // mobile: bottom sheet; desktop: right rail
          "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-lg border-t data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full",
          "sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:max-h-none sm:w-[440px] sm:max-w-[92vw] sm:rounded-none sm:border-t-0 sm:border-l sm:data-[ending-style]:translate-x-full sm:data-[ending-style]:translate-y-0 sm:data-[starting-style]:translate-x-full sm:data-[starting-style]:translate-y-0",
          className,
        )}
        {...props}
      >
        {children}
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

export const SheetTitle = Dialog.Title;
export const SheetClose = Dialog.Close;
