import { cva } from 'class-variance-authority';
import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

import { cn } from '../../lib/cn';

/*
 * The segmented control — a quiet track on the panel ground (2px inset padding).
 * The active segment is an accent wash + inset ring; the rest are dim ink that
 * warms on hover. The class helpers are exported so routed variants (e.g. a
 * Link-based lens toggle) can wear the same skin without a fixed element type.
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
  const segmentRefs = useRef(new Map<T, HTMLButtonElement>());

  // The ARIA radiogroup contract: one tab stop (the checked radio), arrows
  // move — and announce — the selection.
  function handleKey(e: KeyboardEvent<HTMLButtonElement>) {
    const current = options.findIndex((option) => option.value === value);
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = (current + 1) % options.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = (current - 1 + options.length) % options.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = options.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    const target = options[next];
    if (target === undefined) {
      return;
    }
    onChange(target.value);
    segmentRefs.current.get(target.value)?.focus();
  }

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn(segmentedTrackClass, className)}>
      {options.map((option) => (
        <button
          key={option.value}
          ref={(el) => {
            if (el === null) {
              segmentRefs.current.delete(option.value);
            } else {
              segmentRefs.current.set(option.value, el);
            }
          }}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onKeyDown={handleKey}
          onClick={() => {
            onChange(option.value);
          }}
          className={cn(segmentVariants({ active: value === option.value }), segmentClassName)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
