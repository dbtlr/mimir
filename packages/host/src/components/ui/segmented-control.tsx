import {
  SegmentedControl as SdkSegmentedControl,
  SegmentedControlItem,
} from '@ui-sdk/react/segmented-control';
import { cva } from 'class-variance-authority';
import type { KeyboardEvent } from 'react';

import { cn } from '../../lib/cn';

/*
 * The segmented control — a quiet track on the panel ground (2px inset padding).
 * The active segment is an accent wash + inset ring; the rest are dim ink that
 * warms on hover. The class helpers are exported so routed variants (e.g. a
 * Link-based lens toggle) can wear the same skin without a fixed element type.
 * Built on UI SDK's Segmented Control (ADR 0046), which owns the radio-group
 * behavior: one tab stop, arrows move and announce the selection. Two gaps in
 * the SDK are closed here: Enter on a segment must not submit the surrounding
 * form (the SDK's hidden radios would), and Home/End jump to the first/last.
 */
export const segmentedTrackClass =
  'inline-flex gap-px rounded-lg bg-well-850 p-0.5 inset-ring inset-ring-line';

/*
 * A form's track (DESIGN.md, Sizes): the field's full width on the control
 * ground, its edge ink-faint like every control's, 50 tall on a phone (a 3px
 * inset leaves each segment a 44 tap target) and 44 from `md` up.
 */
const FIELD_TRACK_CLASS =
  'flex h-[50px] w-full gap-0.5 rounded-lg bg-well-950 p-[3px] inset-ring inset-ring-ink-faint md:h-11';

/*
 * Segment text is 14/20 at 500 in sentence case (a provider's values keep their
 * own case). The selected segment is an accent wash with a full-strength ring,
 * so the state reads without hue alone; focus is a 2px ring inset inside the
 * segment that replaces the selection ring while it shows.
 */
export const segmentVariants = cva(
  'rounded-md px-2.5 py-1 text-label font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent focus-visible:inset-ring-0',
  {
    defaultVariants: { active: false, size: 'compact' },
    variants: {
      active: {
        false: 'text-ink-dim hover:text-ink-bright',
        true: 'bg-accent/12 text-accent-foreground inset-ring inset-ring-accent',
      },
      size: {
        compact: '',
        field: 'min-w-0 flex-1 truncate px-3 md:px-5',
      },
    },
  },
);

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

// Runs in the capture phase so it wins over the SDK's own Enter-submits-form
// handling; Home/End select and focus the first or last option.
function handleKeyDownCapture<T extends string>(
  e: KeyboardEvent<HTMLElement>,
  options: readonly SegmentedOption<T>[],
  onChange: (value: T) => void,
) {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  // A disabled control (its own, or one a containing Field passes down)
  // changes nothing; UI SDK marks the root `data-disabled` either way.
  if ((e.key !== 'Home' && e.key !== 'End') || e.currentTarget.hasAttribute('data-disabled')) {
    return;
  }
  const index = e.key === 'Home' ? 0 : options.length - 1;
  const target = options[index];
  if (target === undefined) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  onChange(target.value);
  const segments = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
  segments[index]?.focus();
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  segmentClassName,
  size = 'compact',
  ...rest
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** `field` spans a form field's width at the control height; `compact` sits inline. */
  size?: 'compact' | 'field';
  /** Ties the control to a visible label, as a Form sheet field does. */
  'aria-labelledby'?: string;
  className?: string;
  /** Per-segment overrides (e.g. the authoring sheet's pill-shaped, mixed-case type selector). */
  segmentClassName?: string;
}) {
  return (
    <SdkSegmentedControl<T>
      aria-label={rest['aria-labelledby'] === undefined ? ariaLabel : undefined}
      aria-labelledby={rest['aria-labelledby']}
      value={value}
      onValueChange={(next) => {
        if (next !== null) {
          onChange(next);
        }
      }}
      className={cn(size === 'field' ? FIELD_TRACK_CLASS : segmentedTrackClass, className)}
      onKeyDownCapture={(e) => {
        handleKeyDownCapture(e, options, onChange);
      }}
    >
      {options.map((option) => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          className={cn(
            segmentVariants({ active: value === option.value, size }),
            segmentClassName,
          )}
        >
          {option.label}
        </SegmentedControlItem>
      ))}
    </SdkSegmentedControl>
  );
}
