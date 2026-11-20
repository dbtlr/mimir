import { Separator as SdkSeparator } from '@ui-sdk/react/separator';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/*
 * The Separator primitive (ADR 0046): a hairline in `border-line` between
 * groups, horizontal by default and vertical inside a row. Menu groups use it
 * through MenuSeparator.
 */

/** The hairline, sized by orientation. */
export const SEPARATOR_CLASS =
  'shrink-0 bg-line data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch';

export function Separator({ className, ...props }: ComponentProps<typeof SdkSeparator>) {
  return <SdkSeparator className={cn(SEPARATOR_CLASS, className)} {...props} />;
}
