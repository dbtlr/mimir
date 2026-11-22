import {
  CollapsiblePanel as SdkCollapsiblePanel,
  CollapsibleTrigger as SdkCollapsibleTrigger,
} from '@ui-sdk/react/collapsible';
import type { ComponentProps, ReactNode } from 'react';

import { mergeClassName } from './class-name';

/*
 * The Collapsible primitive (ADR 0046): UI SDK's disclosure behavior in the
 * Meridian look. The feed's day fold ("Tuesday · 6 shipped"; ADR 0019,
 * MMR-717) composes it: a trigger row with a chevron, over a panel that
 * animates its height.
 */
export { Collapsible } from '@ui-sdk/react/collapsible';

/** Our own chevron: UI SDK draws its icons only in web.css, which the console does not load. */
function Chevron() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0 text-ink-dim transition-transform duration-150 group-data-[open]:rotate-90"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 16 16"
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

/** A form group's chevron, after its heading: down while folded, up while open. */
function EndChevron() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0 text-ink-dim transition-transform duration-150 group-data-[open]:rotate-180"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 16 16"
    >
      <path d="m3.5 6 4.5 4.5L12.5 6" />
    </svg>
  );
}

/**
 * The always-visible row that opens or closes the panel; the chevron turns when
 * open. A feed's fold leads with it (`start`); a form group's heading ends with
 * it (`end`, as Advanced in a Form sheet).
 */
export function CollapsibleTrigger({
  children,
  className,
  chevron = 'start',
  ...props
}: Omit<ComponentProps<typeof SdkCollapsibleTrigger>, 'children'> & {
  children?: ReactNode;
  chevron?: 'start' | 'end';
}) {
  return (
    <SdkCollapsibleTrigger
      className={mergeClassName(
        'group flex w-full cursor-pointer items-center gap-2 rounded-md py-2 text-left text-sm font-semibold text-ink-bright transition-colors outline-none hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-dim',
        className,
      )}
      {...props}
    >
      {chevron === 'start' && <Chevron />}
      {children}
      {chevron === 'end' && <EndChevron />}
    </SdkCollapsibleTrigger>
  );
}

/** The folded content; its height animates from `--collapsible-panel-height`. */
export function CollapsiblePanel({
  className,
  ...props
}: ComponentProps<typeof SdkCollapsiblePanel>) {
  return (
    <SdkCollapsiblePanel
      className={mergeClassName(
        'h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0',
        className,
      )}
      {...props}
    />
  );
}
