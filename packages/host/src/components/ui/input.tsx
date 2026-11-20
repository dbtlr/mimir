import { Input as SdkInput } from '@ui-sdk/react/input';
import type { ComponentProps } from 'react';

import { mergeClassName } from './class-name';

/*
 * The Input primitive (ADR 0046): a single-line text box in the Meridian look.
 * Inside a Field it labels and describes itself; an invalid Field turns its
 * edge the blocked hue, which reads without the error text (ADR 0019, MMR-736).
 */

/**
 * The text-box look Input, Textarea, Token Input, and a Select's trigger share.
 * The edge is what says where to type, so it meets 3:1 (ink-faint) and warms to
 * ink-dim on hover. Focus turns it accent and joins a 1px accent outline at
 * offset 0: one 2px ring at the control's edge (DESIGN.md, Radii). Outside a
 * form a placeholder remains only in a search box, in ink-dim.
 */
export const CONTROL_EDGE_CLASS =
  'rounded-md border border-ink-faint bg-well-950 text-[15px] leading-[22px] text-ink-bright outline-none transition-colors hover:border-ink-dim focus-visible:border-accent focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-accent';

export const TEXT_FIELD_CLASS = `w-full px-3 ${CONTROL_EDGE_CLASS} placeholder:text-ink-dim aria-[invalid=true]:border-status-blocked data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[readonly]:text-ink-dim`;

export function Input({ className, ...props }: ComponentProps<typeof SdkInput>) {
  return <SdkInput className={mergeClassName(TEXT_FIELD_CLASS, 'h-11', className)} {...props} />;
}
