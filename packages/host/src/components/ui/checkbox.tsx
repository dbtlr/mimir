import { Checkbox as SdkCheckbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import type { ComponentProps } from 'react';

import { mergeClassName } from './class-name';

/*
 * The Checkbox primitive (ADR 0046): UI SDK's checkbox in the Meridian look.
 * A Checkbox holds one of several independent values (ADR 0019, MMR-736), such
 * as "Create another" in the authoring sheet. Checked and indeterminate fill
 * with accent so the state reads on its own; the check and minus are drawn
 * here because UI SDK's own icons ship only in its stylesheet.
 */
export { CheckboxGroup } from '@ui-sdk/react/checkbox';

const ICON_PROPS = {
  'aria-hidden': true,
  className: 'size-3',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  strokeWidth: 2.5,
  viewBox: '0 0 12 12',
} as const;

/** A checkbox with its check or minus; pair it with a text label via `htmlFor` and `id`. */
export function Checkbox({ className, ...props }: ComponentProps<typeof SdkCheckbox>) {
  return (
    <SdkCheckbox
      className={mergeClassName(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-2 border-ink-dim bg-well-900 text-action-foreground transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'data-[checked]:border-accent data-[checked]:bg-accent data-[indeterminate]:border-accent data-[indeterminate]:bg-accent',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
        className,
      )}
      {...props}
    >
      <CheckboxIndicator>
        {(state) =>
          state.indeterminate ? (
            <svg {...ICON_PROPS}>
              <path d="M2.5 6h7" />
            </svg>
          ) : (
            <svg {...ICON_PROPS}>
              <path d="M2.5 6.5 5 9l4.5-5.5" />
            </svg>
          )
        }
      </CheckboxIndicator>
    </SdkCheckbox>
  );
}
