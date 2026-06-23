import { Menu } from "@base-ui-components/react/menu";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Vendored Base UI menu — the per-card actions menu (kebab). */
export function MenuRoot(props: ComponentProps<typeof Menu.Root>) {
  return <Menu.Root {...props} />;
}

export function MenuTrigger(props: ComponentProps<typeof Menu.Trigger>) {
  return <Menu.Trigger {...props} />;
}

export function MenuContent({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.Popup> & { children: ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.Positioner align="end" sideOffset={4} className="z-50">
        <Menu.Popup
          className={cn(
            "min-w-36 rounded-md border border-line-bright bg-well-800 p-1 shadow-xl outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="microlabel px-2 py-1 text-ink-faint">{children}</div>;
}

export function MenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return (
    <Menu.Item
      className={cn(
        "flex w-full cursor-default items-center gap-2 rounded-[3px] px-2 py-2.5 text-left text-[0.875rem] text-ink outline-none select-none md:py-1.5 md:text-[0.75rem]",
        "data-[highlighted]:bg-well-700 data-[highlighted]:text-ink-bright",
        className,
      )}
      {...props}
    />
  );
}
