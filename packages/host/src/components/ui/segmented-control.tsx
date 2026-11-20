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

export const segmentVariants = cva(
  'microlabel rounded-md px-2.5 py-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-accent',
  {
    defaultVariants: { active: false },
    variants: {
      active: {
        false: 'text-ink-dim hover:text-ink',
        true: 'bg-accent/12 text-accent-foreground inset-ring inset-ring-accent/24',
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
  if (e.key !== 'Home' && e.key !== 'End') {
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
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  /** Per-segment overrides (e.g. the authoring sheet's pill-shaped, mixed-case type selector). */
  segmentClassName?: string;
}) {
  return (
    <SdkSegmentedControl<T>
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => {
        if (next !== null) {
          onChange(next);
        }
      }}
      className={cn(segmentedTrackClass, className)}
      onKeyDownCapture={(e) => {
        handleKeyDownCapture(e, options, onChange);
      }}
    >
      {options.map((option) => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          className={cn(segmentVariants({ active: value === option.value }), segmentClassName)}
        >
          {option.label}
        </SegmentedControlItem>
      ))}
    </SdkSegmentedControl>
  );
}
