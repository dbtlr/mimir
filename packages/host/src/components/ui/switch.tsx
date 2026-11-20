import { Switch as SdkSwitch, SwitchThumb } from '@ui-sdk/react/switch';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/*
 * The Switch primitive (ADR 0046): UI SDK's switch in the look ADR 0019's
 * MMR-712 refinement sets for the Choice pattern's Switch, a setting that
 * applies as soon as it changes. It is 40 by 24 pixels, accent when on and
 * faint ink when off, with a white thumb. A `<label>` row wraps it and its
 * text, so a tap on the text flips it.
 */
export function Switch({ className, ...props }: ComponentProps<typeof SdkSwitch>) {
  return (
    <SdkSwitch
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full bg-ink-faint p-[3px] transition-colors outline-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'data-[checked]:bg-accent data-[disabled]:cursor-default data-[disabled]:opacity-60',
        className,
      )}
      {...props}
    >
      <SwitchThumb className="size-[18px] rounded-full bg-white transition-transform light:shadow-card data-[checked]:translate-x-4" />
    </SdkSwitch>
  );
}
