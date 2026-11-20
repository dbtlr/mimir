import { Separator as SdkSeparator } from '@ui-sdk/react/separator';
import type { ComponentProps } from 'react';

import { mergeClassName } from './class-name';

/*
 * The Separator primitive (ADR 0046): a hairline in `border-line` between
 * groups, horizontal by default and vertical inside a row. Menu groups use it
 * through MenuSeparator.
 */

/**
 * A fixed 1px horizontal hairline with vertical margin, for parts that render
 * no data-orientation (MenuSeparator, SelectSeparator in SDK beta.13).
 */
export const LIST_DIVIDER_CLASS = 'my-1 h-px w-full shrink-0 bg-line';

/** The hairline, sized by orientation. */
export const SEPARATOR_CLASS =
  'shrink-0 bg-line data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch';

export function Separator({ className, ...props }: ComponentProps<typeof SdkSeparator>) {
  return <SdkSeparator className={mergeClassName(SEPARATOR_CLASS, className)} {...props} />;
}
