import { Switch as BaseSwitch } from '@base-ui-components/react/switch';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/**
 * Vendored Base UI switch: an on-or-off setting that takes effect when it
 * flips (ADR 0019, MMR-712 refinement). 40 by 24 pixels, accent when on; name
 * it with `aria-label` or a wrapping label.
 */
export function Switch({ className, ...props }: ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full bg-line-bright p-[3px] transition-colors outline-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'data-[checked]:bg-accent data-[disabled]:cursor-default data-[disabled]:opacity-60',
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="size-[18px] rounded-full bg-white shadow transition-transform data-[checked]:translate-x-4" />
    </BaseSwitch.Root>
  );
}
