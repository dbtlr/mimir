import { Radio as SdkRadio, RadioIndicator } from '@ui-sdk/react/radio';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/*
 * The Radio primitive (ADR 0046): UI SDK's radio group in the Meridian look.
 * A Radio holds options that need a label of more than a word (a Choice, the
 * Walkthrough's steps; ADR 0019, MMR-736). The checked radio reads on its own:
 * an accent ring around an accent dot, not a faint tint.
 */
export { RadioGroup } from '@ui-sdk/react/radio';

/** A radio with its dot; pair it with a text label via `htmlFor` and `id`. */
export function Radio({ className, ...props }: ComponentProps<typeof SdkRadio>) {
  return (
    <SdkRadio
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-full border-2 border-ink-dim bg-well-900 transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'data-[checked]:border-accent data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
        className,
      )}
      {...props}
    >
      <RadioIndicator className="size-2 rounded-full bg-accent" />
    </SdkRadio>
  );
}
