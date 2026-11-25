import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { ActionButton } from '../ui/action-button';
import { Drawer, DrawerBackdrop, DrawerContent, DrawerTitle, useDrawerSide } from '../ui/drawer';
import { FIELD_LABEL_CLASS } from '../ui/field';
import { SegmentedControl } from '../ui/segmented-control';
import type { SegmentedOption } from '../ui/segmented-control';
import { BLOCK_PROPS } from './form-block';
import { useFinalFocus } from './opener';
import type { FinalFocus } from './opener';
import { firstViewEnd } from './resting-body';
import { SHEET_FOOTER_CLASS, SheetBody, SheetClose, measureRests } from './sheet-chrome';

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
        // On a phone the grip sits 12 from the top and the edge over the scrim is the
        // sheet seam, as on the preview's bottom sheet (DESIGN.md, Sheet seam).
        className="gap-0 overflow-hidden p-0 data-[side=bottom]:border-sheet-seam data-[side=bottom]:pt-4 data-[side=bottom]:pb-0 light:data-[side=bottom]:elevation-sheet-up"
      >
        <header
          data-slot="filter-sheet-header"
          className="flex shrink-0 items-center gap-3 border-b border-line pt-3 pr-2 pb-3 pl-5 md:pt-5 md:pr-6 md:pb-5 md:pl-8"
        >
          <DrawerTitle className="min-w-0 flex-1 text-dossier leading-6 font-semibold text-ink-bright">
            {title}
          </DrawerTitle>
          {/* The close's tap target reaches into the header's padding, so the header is the
              title's line and its 12 (20 from `md` up) above and below. */}
          <SheetClose onClick={onClose} className="-my-2.5 md:-my-1.5" />
        </header>
        <FilterBody>{children}</FilterBody>
        <div data-slot="filter-sheet-footer" className={SHEET_FOOTER_CLASS}>
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

/**
 * The scrolling body (`SheetBody`). On a phone the sheet fits its content up
 * to 88% of the viewport; when the fields run past that, the body ends a field
 * gap below the last field that fits whole, so the first view never cuts a
 * field at the footer and the next shows on scroll. From `md` up the panel is
 * full height, so the body fills it and the footer stays on its bottom edge.
 */
function FilterBody({ children }: { children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const bottomSheet = useDrawerSide() === 'bottom';
  useLayoutEffect(() => {
    const element = body.current;
    if (element === null || !bottomSheet || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const fit = () => {
      // Measure the room the sheet gives the body uncapped, then cap it.
      element.style.maxHeight = '';
      const available = element.clientHeight;
      const end =
        element.scrollHeight > available
          ? firstViewEnd(measureRests(element).extents, available)
          : undefined;
      element.style.maxHeight = end === undefined ? '' : `${String(end)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    const content = element.firstElementChild;
    if (content !== null) {
      observer.observe(content);
    }
    const view = element.ownerDocument.defaultView;
    view?.addEventListener('resize', fit);
    // The sheet is sized to the visible viewport, which can change alone (a zoom, a bar).
    view?.visualViewport?.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      view?.removeEventListener('resize', fit);
      view?.visualViewport?.removeEventListener('resize', fit);
      // A sheet that crosses `md` while open becomes a full-height panel, uncapped.
      element.style.maxHeight = '';
    };
  }, [bottomSheet]);
  return (
    <SheetBody body={body} slot="filter-sheet-body">
      {children}
    </SheetBody>
  );
}

/** One pill's value and label; `name` is its accessible name when the label is a glyph ("S" for Small). */
export type FilterOption<T extends string> = { value: T; label: ReactNode; name?: string };

/**
 * The pill's tap area and its 36 pill, which draws the state and the focus
 * ring. On a phone the area is 44 tall and reaches 4 past each side, half the
 * 8 between pills, so even a 36 pill ("S") has a 44 square to tap.
 */
const PILL_TARGET = cn(
  'group/pill relative inline-flex min-h-11 cursor-pointer items-center md:min-h-9',
  "max-md:before:absolute max-md:before:inset-y-0 max-md:before:-inset-x-1 max-md:before:content-['']",
);
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
      {...BLOCK_PROPS}
      role={kind === 'radio' ? 'radiogroup' : 'group'}
      aria-labelledby={labelId}
      className={cn(BLOCK_PROPS.className, 'flex flex-col gap-2')}
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
          // The button owns the whole tap area: under a wrapper, the area's ::before would sit over it and take the tap.
          <button
            type="button"
            onClick={() => {
              revealed.current = options.find((o) => !shown.includes(o))?.value ?? null;
              setExpanded(true);
            }}
            className={cn(PILL_TARGET, 'outline-none')}
          >
            <span
              className={cn(
                PILL,
                'group-focus-visible/pill:outline-2 group-focus-visible/pill:outline-offset-2 group-focus-visible/pill:outline-solid group-focus-visible/pill:outline-accent',
              )}
            >
              {hidden} more
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A field of a few one-word choices on one row, such as Sort: a Segmented
 * Control. `fit` sizes each segment to its label, with 6 of padding a side on
 * a phone and 44 at least, so a row of five (the Seeds list's Show) fits at
 * 390 where equal shares would cut the longest label.
 */
export function FilterSegments<T extends string>({
  label,
  options,
  value,
  onChange,
  fit = false,
}: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  fit?: boolean;
}) {
  const labelId = useId();
  return (
    <div {...BLOCK_PROPS} className={cn(BLOCK_PROPS.className, 'flex flex-col gap-2')}>
      <span id={labelId} className={FIELD_LABEL_CLASS}>
        {label}
      </span>
      <SegmentedControl
        size="field"
        ariaLabel={label}
        options={options}
        value={value}
        onChange={onChange}
        segmentClassName={fit ? 'min-w-11 flex-auto px-1.5 md:px-3' : undefined}
      />
    </div>
  );
}
