import { Separator as BaseSeparator } from "@base-ui-components/react/separator";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** Vendored shadcn-style separator over the Base UI primitive. */
export function Separator({ className, ...props }: ComponentProps<typeof BaseSeparator>) {
  return <BaseSeparator className={cn("h-px w-full bg-line", className)} {...props} />;
}
