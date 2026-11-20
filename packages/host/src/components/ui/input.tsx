import { Input as SdkInput } from '@ui-sdk/react/input';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/*
 * The Input primitive (ADR 0046): a single-line text box in the Meridian look.
 * Inside a Field it labels and describes itself; an invalid Field turns its
 * edge the blocked hue, which reads without the error text (ADR 0019, MMR-736).
 */

/** The text-box look Input, Textarea, and Token Input share. */
export const TEXT_FIELD_CLASS =
  'w-full rounded-md border border-line-bright bg-well-950 px-3 text-[15px] text-ink-bright outline-none placeholder:text-ink-ghost focus-visible:border-accent aria-[invalid=true]:border-status-blocked data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[readonly]:text-ink-dim';

export function Input({ className, ...props }: ComponentProps<typeof SdkInput>) {
  return <SdkInput className={cn(TEXT_FIELD_CLASS, 'h-11', className)} {...props} />;
}
