import {
  SelectContent as SdkSelectContent,
  SelectItem as SdkSelectItem,
  SelectItemIndicator,
  SelectSeparator as SdkSelectSeparator,
  SelectTrigger as SdkSelectTrigger,
  SelectValue,
} from '@ui-sdk/react/select';
import type { ComponentProps, ReactNode } from 'react';

import { mergeClassName } from './class-name';
import { LIST_DIVIDER_CLASS } from './separator';

/*
 * The Select primitive (ADR 0046): UI SDK's select in the Meridian look. A
 * Select holds a longer fixed list, such as T3's models or a sort order (ADR
 * 0019, MMR-736). The trigger and the selected item's check are drawn here
 * because UI SDK's own icons ship only in its stylesheet.
 */
export { Select, SelectGroup, SelectGroupLabel } from '@ui-sdk/react/select';

const ICON_PROPS = {
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  strokeWidth: 2,
  viewBox: '0 0 12 12',
} as const;

/** The closed control: the selected label (or the placeholder) and a chevron. */
export function SelectTrigger({
  className,
  ...props
}: Omit<ComponentProps<typeof SdkSelectTrigger>, 'children'>) {
  return (
    <SdkSelectTrigger
      className={mergeClassName(
        'inline-flex min-h-9 min-w-44 items-center justify-between gap-2 rounded-md border border-line-bright bg-well-900 px-2.5 text-meta text-ink-bright transition-colors hover:border-ink-faint',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'data-[placeholder]:text-ink-dim data-[open]:border-accent data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
        className,
      )}
      {...props}
    >
      <SelectValue />
      <svg {...ICON_PROPS} className="size-3 shrink-0 text-ink-dim">
        <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
      </svg>
    </SdkSelectTrigger>
  );
}

/** The popup list, as wide as its trigger at least. */
export function SelectContent({ className, ...props }: ComponentProps<typeof SdkSelectContent>) {
  return (
    <SdkSelectContent
      sideOffset={4}
      className={mergeClassName(
        'z-50 max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto rounded-md border border-line-bright bg-well-850 p-1 text-ink shadow-xl outline-none transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

/** One choice: a highlighted row lifts to well-800; the selected row carries a check. */
export function SelectItem({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof SdkSelectItem>, 'children'> & { children: ReactNode }) {
  return (
    <SdkSelectItem
      className={mergeClassName(
        'flex min-h-8 cursor-default items-center justify-between gap-3 rounded-sm px-2 text-meta outline-none select-none',
        'data-[highlighted]:bg-well-800 data-[highlighted]:text-ink-bright data-[selected]:text-ink-bright',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
        className,
      )}
      {...props}
    >
      {children}
      <SelectItemIndicator className="text-accent-foreground">
        <svg {...ICON_PROPS} className="size-3">
          <path d="M2.5 6.5 5 9l4.5-5.5" />
        </svg>
      </SelectItemIndicator>
    </SdkSelectItem>
  );
}

/** A hairline between groups of choices. */
export function SelectSeparator({
  className,
  ...props
}: ComponentProps<typeof SdkSelectSeparator>) {
  return (
    <SdkSelectSeparator className={mergeClassName(LIST_DIVIDER_CLASS, className)} {...props} />
  );
}
