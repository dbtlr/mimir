import { ScrollArea as BaseScrollArea } from "@base-ui-components/react/scroll-area";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Vendored shadcn-style scroll area over the Base UI primitive. */
export function ScrollArea({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseScrollArea.Root> & { children: ReactNode }) {
  return (
    <BaseScrollArea.Root className={cn("overflow-hidden", className)} {...props}>
      <BaseScrollArea.Viewport className="h-full w-full overscroll-contain">
        {children}
      </BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar
        orientation="vertical"
        className="flex w-1 justify-center rounded bg-transparent opacity-0 transition-opacity data-[hovering]:opacity-100 data-[scrolling]:opacity-100"
      >
        <BaseScrollArea.Thumb className="w-full rounded bg-well-700" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}
