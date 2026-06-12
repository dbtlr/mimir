import { Tabs as BaseTabs } from "@base-ui-components/react/tabs";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** Vendored shadcn-style tabs over the Base UI primitive (mobile board lens). */
export function Tabs(props: ComponentProps<typeof BaseTabs.Root>) {
  return <BaseTabs.Root {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List
      className={cn(
        "flex w-full items-stretch gap-px overflow-x-auto rounded-md border border-line bg-well-850 p-px",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        "microlabel flex flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2 py-2 text-ink-dim transition-colors",
        "data-[selected]:bg-well-700 data-[selected]:text-ink-bright",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) {
  return <BaseTabs.Panel className={cn("outline-none", className)} {...props} />;
}
