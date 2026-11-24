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
  'rounded-md border border-ink-faint bg-well-950 text-[15px] leading-[22px] text-ink-bright outline-none transition-colors not-data-[disabled]:hover:border-ink-dim focus-visible:border-accent focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-solid focus-visible:outline-accent';

/**
 * A disabled field is quiet, not faded, as a disabled commit is (DESIGN.md,
 * Color roles; MMR-777). Its value stays in ink-dim at full opacity, 4.5:1 or
 * better on its well-950 ground in both themes, so what is set still reads.
 * Only the edge drops to ink-ghost, and a glyph inside it (a chevron) to
 * ink-faint; hover leaves it. An invalid one, or one holding an invalid input,
 * keeps its blocked edge: the ghost rule skips it, since Tailwind writes
 * `data-` rules after `aria-` and `has-` ones. Every field primitive that
 * shows a value takes it.
 */
export const QUIET_DISABLED_FIELD_CLASS =
  'data-[disabled]:cursor-not-allowed data-[disabled]:not-aria-[invalid=true]:not-has-[[aria-invalid=true]]:border-ink-ghost data-[disabled]:text-ink-dim data-[disabled]:[&_svg]:text-ink-faint';

export const TEXT_FIELD_CLASS = `w-full px-3 ${CONTROL_EDGE_CLASS} placeholder:text-ink-dim aria-[invalid=true]:border-status-blocked ${QUIET_DISABLED_FIELD_CLASS} data-[readonly]:text-ink-dim`;

export function Input({ className, ...props }: ComponentProps<typeof SdkInput>) {
  return <SdkInput className={mergeClassName(TEXT_FIELD_CLASS, 'h-11', className)} {...props} />;
}
