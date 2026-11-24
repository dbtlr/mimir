import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { ActionButton } from '../ui/action-button';
import { Drawer, DrawerBackdrop, DrawerContent, DrawerTitle } from '../ui/drawer';
import { FIELD_LABEL_CLASS } from '../ui/field';
import { CloseIcon } from '../ui/icons';
import { SegmentedControl } from '../ui/segmented-control';
import type { SegmentedOption } from '../ui/segmented-control';
import { useFinalFocus } from './opener';
import type { FinalFocus } from './opener';

/*
 * The Filter sheet (ADR 0019, MMR-724 refinement; DESIGN.md, List page): a list
 * page's filters on one scrolling page, which apply only when its commit is
 * pressed. A Sheet like the Content sheet: a bottom sheet below `md` and a 440
 * panel from the right from `md` up, modal at every width, closed by Escape,
 * an outside press, or its close, with focus back on the chip that opened it.
 * Its header and footer stay put while the body scrolls. The footer holds
 * Clear, which resets the fields and applies nothing, and the commit, which
 * names what it will show ("Show 5 tasks").
 *
 * Its choices are pills: one choice is a radio group, several are a group of
 * checkboxes. Both are native inputs, so the arrow keys move a radio group's
 * choice and Space toggles a checkbox, and each pill is 36 tall in a 44 tap
 * area on a phone.
 */

export function FilterSheet({
  open,
  onClose,
  title,
  finalFocus,
  commitLabel,
  commitDisabled = false,
  onCommit,
  onClear,
  children,
}: {
  open: boolean;
  /** Backs out: Escape, an outside press, or the close. Nothing applies. */
  onClose: () => void;
  /** Names the sheet ("Filter tasks"). */
  title: string;
  /** Where focus goes on close: by default the control that opened it. */
  finalFocus?: FinalFocus;
  /** Names what the commit shows ("Show 5 tasks"). */
  commitLabel: string;
  /** The fields select nothing the list could show. */
  commitDisabled?: boolean;
  /** Applies the fields; the sheet closes after. */
  onCommit: () => void;
  /** Resets the fields to the list's defaults, without applying them. */
  onClear: () => void;
  /** The fields, in order: FilterPills and FilterSegments. */
  children: ReactNode;
}) {
  const returnTo = useFinalFocus(open, finalFocus);
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DrawerBackdrop />
      <DrawerContent
        size="content"
        finalFocus={returnTo}
        className="gap-0 overflow-hidden p-0 data-[side=bottom]:pb-0"
      >
        <header
          data-slot="filter-sheet-header"
          className="flex shrink-0 items-center gap-3 border-b border-line pt-3 pr-2 pb-3 pl-5 md:pt-5 md:pr-6 md:pb-5 md:pl-8"
        >
          <DrawerTitle className="min-w-0 flex-1 text-dossier font-semibold text-ink-bright">
            {title}
          </DrawerTitle>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-line hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:size-9"
          >
            <CloseIcon className="size-5 md:size-[18px]" />
          </button>
        </header>
        <div
          data-slot="filter-sheet-body"
          className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pt-6 pb-8 md:px-8 md:pt-8 md:pb-10"
        >
          {children}
        </div>
        <div
          data-slot="filter-sheet-footer"
          className="flex shrink-0 items-center gap-3 border-t border-line bg-well-850 px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:justify-end md:px-8 md:py-4"
        >
          <ActionButton
            size="form"
            variant="formOutline"
            onClick={onClear}
            className="max-md:flex-1"
          >
            Clear
          </ActionButton>
          <ActionButton
            size="form"
            disabled={commitDisabled}
            onClick={() => {
              onCommit();
              onClose();
            }}
            className="max-md:flex-1"
          >
            {commitLabel}
          </ActionButton>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** One pill's value and label; `name` is its accessible name when the label is a glyph ("S" for Small). */
export type FilterOption<T extends string> = { value: T; label: ReactNode; name?: string };

/** The pill's tap area (44 on a phone) and its 36 pill, which draws the state and the focus ring. */
const PILL_TARGET =
  'group/pill relative inline-flex min-h-11 cursor-pointer items-center md:min-h-9';
const PILL = cn(
  'inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-full px-3 text-label font-medium whitespace-nowrap text-ink-bright inset-ring inset-ring-ink-faint transition-colors',
  'group-hover/pill:inset-ring-ink-dim',
  'group-has-checked/pill:bg-accent/12 group-has-checked/pill:font-semibold group-has-checked/pill:text-accent-foreground group-has-checked/pill:inset-ring-accent',
  'group-has-focus-visible/pill:outline-2 group-has-focus-visible/pill:outline-offset-2 group-has-focus-visible/pill:outline-solid group-has-focus-visible/pill:outline-accent',
);

/**
 * A field of pills: one choice (`radio`) or several (`checkbox`). A long set
 * shows its first `limit` pills, and those checked, then "N more", which shows
 * the rest in place and moves focus to the first of them.
 */
export function FilterPills<T extends string>({
  label,
  kind,
  options,
  value,
  onChange,
  limit,
  mono = false,
}: {
  label: string;
  kind: 'radio' | 'checkbox';
  options: readonly FilterOption<T>[];
  /** The checked values; a radio group has one. */
  value: readonly T[];
  onChange: (value: T[]) => void;
  /** How many pills show before "N more"; every pill when absent. */
  limit?: number;
  /** The labels are machine vocabulary (p0, S), set in mono. */
  mono?: boolean;
}) {
  const name = useId();
  const labelId = useId();
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const capped = limit !== undefined && !expanded && options.length > limit;
  const shown = capped
    ? options.filter((option, index) => index < limit || value.includes(option.value))
    : options;
  const hidden = options.length - shown.length;
  // The first pill "N more" revealed, until the effect below moves focus to
  // it; the button unmounts as it is pressed.
  const revealed = useRef<T | null>(null);
  useEffect(() => {
    if (expanded && revealed.current !== null) {
      const first = [...(list.current?.querySelectorAll('input') ?? [])].find(
        (input) => input.value === revealed.current,
      );
      first?.focus();
      revealed.current = null;
    }
  }, [expanded]);
  return (
    <div
      role={kind === 'radio' ? 'radiogroup' : 'group'}
      aria-labelledby={labelId}
      className="flex flex-col gap-2"
    >
      <span id={labelId} className={FIELD_LABEL_CLASS}>
        {label}
      </span>
      <div ref={list} className="-my-1 flex flex-wrap gap-x-2 md:my-0 md:gap-y-2">
        {shown.map((option) => {
          const checked = value.includes(option.value);
          return (
            <label key={option.value} className={PILL_TARGET}>
              <input
                type={kind}
                name={name}
                value={option.value}
                checked={checked}
                aria-label={option.name}
                onChange={(event) => {
                  if (kind === 'radio') {
                    onChange([option.value]);
                  } else {
                    onChange(
                      event.target.checked
                        ? options
                            .map((o) => o.value)
                            .filter((v) => v === option.value || value.includes(v))
                        : value.filter((v) => v !== option.value),
                    );
                  }
                }}
                className="peer sr-only"
              />
              <span
                aria-hidden={option.name === undefined ? undefined : true}
                className={cn(PILL, mono && 'font-mono')}
              >
                {option.label}
              </span>
            </label>
          );
        })}
        {hidden > 0 && (
          <span className={PILL_TARGET}>
            <button
              type="button"
              onClick={() => {
                revealed.current = options.find((o) => !shown.includes(o))?.value ?? null;
                setExpanded(true);
              }}
              className={cn(
                PILL,
                'cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-accent',
              )}
            >
              {hidden} more
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** A field of a few one-word choices on one row, such as Sort: a Segmented Control. */
export function FilterSegments<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className={FIELD_LABEL_CLASS}>
        {label}
      </span>
      <SegmentedControl
        size="field"
        ariaLabel={label}
        options={options}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}
