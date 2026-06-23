import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** Vendored shadcn-style badge — chip-dense, mono-friendly (console flavor). */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-[3px] px-1.5 py-px text-[0.6875rem] font-medium whitespace-nowrap md:text-[0.625rem]",
  {
    variants: {
      variant: {
        default: "bg-well-700 text-ink",
        outline: "border border-line-bright text-ink",
        mono: "bg-well-800 font-mono text-[0.6875rem] text-ink-dim md:text-[0.625rem]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
