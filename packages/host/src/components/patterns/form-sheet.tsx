import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ComponentProps, ReactNode, RefObject } from 'react';

import { cn } from '../../lib/cn';
import { ActionButton } from '../ui/action-button';
import { Checkbox } from '../ui/checkbox';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../ui/collapsible';
import {
  Drawer,
  DrawerBackdrop,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  useDrawerSide,
} from '../ui/drawer';
import { Field, FieldDescription, FieldLabel, FieldOptional, FORM_PROSE_CLASS } from '../ui/field';
import { CloseIcon } from '../ui/icons';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { BLOCK_PROPS, BLOCK_SELECTOR } from './form-block';
import { useFinalFocus } from './opener';
import type { FinalFocus } from './opener';
import { useOpening } from './opening';

/*
 * Form sheet (ADR 0019, MMR-736): use it to create or edit a record with
 * several fields, one form per kind of record for both. A Drawer that is full
 * screen on a phone, with the close in a top bar and the commit full width in
 * a bottom bar, and a 640 panel from the right from `md` up, whose footer
 * holds Cancel then the commit. The header and footer stay put while the body
 * scrolls; a hairline shadow under the header says content sits above the
 * fold. The numbers are in DESIGN.md (The Form sheet, assembled).
 *
 * It opens on its first field, holds the commit disabled until the form can
 * be sent, commits once per opening (`useOpening`), and holds Escape, Cancel,
 * and the close while a commit runs. A commit that calls the host returns its
 * promise (a mutation's `mutateAsync`): the sheet closes when it resolves and
 * stays, values intact and focus back on the commit, when it rejects. Focus
 * returns to the opener on close.
 */

/** The field gap: a resting scroll keeps this much between the header and the first label. */
const FIELD_GAP = 24;

/** What a control in the body can take focus as, for the default first-field focus. */
const FOCUSABLE =
  'input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A block's visible extent in the body's scroll space: its box less the
 * height a negative margin pulls back (a check row's or a collapsible
 * heading's tap row), so the rests measure its text, not its tap row.
 */
export type BlockExtent = { top: number; bottom: number };

/**
 * The scroll positions where the body rests cleanly, one per block: the block
 * a field gap below the header, or lower when that would leave a sliver of the
 * block above it showing (a heading 20 above its first label). When content
 * that is not a block follows the last one (`contentFollows`: Lifecycle's
 * explanation and Archive), the scroll that hides that last block whole is a
 * rest too.
 */
export function restsOf(blocks: readonly BlockExtent[], contentFollows: boolean): number[] {
  const rests: number[] = [];
  let above = Number.NEGATIVE_INFINITY;
  for (const block of blocks) {
    rests.push(Math.max(block.top - FIELD_GAP, above));
    above = Math.max(above, block.bottom);
  }
  if (blocks.length > 0 && contentFollows) {
    rests.push(above);
  }
  return rests;
}

/**
 * The bottom room a body needs so the end of its scroll rests cleanly: the
 * smallest rest at or past the natural end, less that end, measured in the
 * body's scroll space. Zero when the natural end already is one, or when
 * nothing scrolls.
 */
export function restingRoom(naturalEnd: number, rests: readonly number[]): number {
  if (naturalEnd <= 0) {
    return 0;
  }
  const after = rests.filter((rest) => rest > 0);
  if (after.some((rest) => Math.abs(rest - naturalEnd) < 1)) {
    return 0;
  }
  const next = after.filter((rest) => rest > naturalEnd).toSorted((x, y) => x - y)[0];
  return next === undefined ? 0 : Math.ceil(next - naturalEnd);
}

/** Where a newly focused control sits in the body's scroll space. */
export type FocusedPlace = {
  /** The rest of the block (the field) that holds it, or a field gap above the control when none does. */
  rest: number;
  controlTop: number;
  controlBottom: number;
};

/** The body's scroll at the moment focus moves. */
export type BodyScroll = {
  scrollTop: number;
  clientHeight: number;
  maxScroll: number;
  /** The clearance a rest keeps above the footer: the body's bottom padding. */
  endClearance: number;
  /** Every rest, from `restsOf`. */
  rests: readonly number[];
};

/**
 * The scroll that brings a newly focused control fully into view, or `null`
 * when it already is (WCAG 2.4.11). It lands on a rest where one shows the
 * whole field: its block a field gap below the header, the control clear of
 * the footer by the body's end padding. The rests are the top, each block's,
 * and the end, and the nearest to the current scroll wins. When no rest holds
 * the field, it scrolls the least that shows the control whole, and when even
 * the control is taller than the body, to its top.
 */
export function focusScroll(place: FocusedPlace, scroll: BodyScroll): number | null {
  const { scrollTop, clientHeight, maxScroll, endClearance, rests } = scroll;
  const { rest: own, controlTop, controlBottom } = place;
  // In view, clear of the footer by the end padding when the control and that clearance fit:
  // the browser's own focus scroll, which may run first, leaves a control flush with the footer.
  const clearance = controlBottom - controlTop + endClearance <= clientHeight ? endClearance : 0;
  if (
    controlTop >= scrollTop - 0.5 &&
    controlBottom + clearance <= scrollTop + clientHeight + 0.5
  ) {
    return null;
  }
  const clamp = (value: number) => Math.min(Math.max(value, 0), maxScroll);
  const low = controlBottom + endClearance - clientHeight;
  const fits = [0, maxScroll, ...rests]
    .map(clamp)
    .filter((at) => at >= low - 0.5 && at <= own + 0.5)
    .toSorted((x, y) => Math.abs(x - scrollTop) - Math.abs(y - scrollTop));
  if (fits[0] !== undefined) {
    return fits[0];
  }
  const least = controlBottom - clientHeight;
  if (least > controlTop) {
    return clamp(controlTop);
  }
  return clamp(Math.min(Math.max(scrollTop, least), controlTop));
}

/** How far a negative margin on an element pulls its edge in, in px. */
function pulled(element: Element | null, side: 'marginTop' | 'marginBottom'): number {
  if (element === null) {
    return 0;
  }
  const margin = Number.parseFloat(getComputedStyle(element)[side]);
  return Number.isNaN(margin) ? 0 : Math.max(0, -margin);
}

/** The body's blocks, measured in its scroll space, and the rests they make. */
function measureRests(element: HTMLElement) {
  const origin = element.getBoundingClientRect().top - element.scrollTop;
  const blocks = [...element.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)];
  const extents = blocks.map((block) => {
    const rect = block.getBoundingClientRect();
    const first = block.firstElementChild;
    return {
      bottom:
        rect.bottom -
        origin -
        Math.max(pulled(block, 'marginBottom'), pulled(first, 'marginBottom')),
      top: rect.top - origin + Math.max(pulled(block, 'marginTop'), pulled(first, 'marginTop')),
    };
  });
  const content = element.lastElementChild;
  const last = blocks.at(-1);
  const contentFollows =
    content !== null &&
    last !== undefined &&
    content.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom > 1;
  const rests = restsOf(extents, contentFollows);
  return { blocks, origin, rests };
}

/** Brings the body's focused control into view, when focus sits in the body. */
function keepFocusInView(element: HTMLElement, room: number) {
  const focused = element.ownerDocument.activeElement;
  if (!(focused instanceof HTMLElement) || focused === element || !element.contains(focused)) {
    return;
  }
  const { blocks, origin, rests } = measureRests(element);
  const control = focused.getBoundingClientRect();
  const holder = blocks.findIndex((block) => block.contains(focused));
  const padding = Number.parseFloat(getComputedStyle(element).paddingBottom);
  const target = focusScroll(
    {
      controlBottom: control.bottom - origin,
      controlTop: control.top - origin,
      rest: rests[holder] ?? control.top - origin - FIELD_GAP,
    },
    {
      clientHeight: element.clientHeight,
      endClearance: Number.isNaN(padding) ? FIELD_GAP : padding - room,
      maxScroll: element.scrollHeight - element.clientHeight,
      rests,
      scrollTop: element.scrollTop,
    },
  );
  if (target !== null) {
    element.scrollTop = target;
  }
}

/**
 * The scrolling body. It keeps a resting scroll a field gap below the header
 * (DESIGN.md, Sheets): it grows its bottom padding when the natural end of its
 * scroll would cut a field under the header, and when focus moves to a control
 * out of view, it scrolls to the nearest rest that shows it whole. It does not
 * snap: a mandatory snap could rest the focused field under a bar. It mounts
 * with the sheet's content, so it measures what is shown, and reports whether
 * it has scrolled, for the header's shadow.
 */
function FormBody({
  body,
  onScrolled,
  children,
}: {
  body: RefObject<HTMLDivElement | null>;
  onScrolled: (scrolled: boolean) => void;
  children: ReactNode;
}) {
  const [room, setRoom] = useState(0);
  const roomRef = useRef(0);

  useLayoutEffect(() => {
    const element = body.current;
    if (element === null) {
      return undefined;
    }
    // Focus moves before the browser scrolls it into view, so a control this
    // scroll shows whole needs no scroll of the browser's own.
    const onFocusIn = () => {
      keepFocusInView(element, roomRef.current);
    };
    element.addEventListener('focusin', onFocusIn);
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        element.removeEventListener('focusin', onFocusIn);
      };
    }
    const measure = () => {
      if (element.clientHeight === 0) {
        return;
      }
      const naturalEnd = element.scrollHeight - roomRef.current - element.clientHeight;
      const next = restingRoom(naturalEnd, measureRests(element).rests);
      if (next !== roomRef.current) {
        roomRef.current = next;
        setRoom(next);
      }
      // A body that shrinks (a phone's keyboard) or a field that grows keeps focus in view.
      keepFocusInView(element, next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const content = element.lastElementChild;
    if (content !== null) {
      observer.observe(content);
    }
    return () => {
      element.removeEventListener('focusin', onFocusIn);
      observer.disconnect();
    };
  }, [body]);

  useEffect(() => {
    onScrolled(false);
  }, [onScrolled]);

  return (
    <div
      ref={body}
      data-slot="form-sheet-body"
      onScroll={(event) => {
        onScrolled(event.currentTarget.scrollTop > 0);
      }}
      style={room > 0 ? { paddingBottom: `calc(var(--form-body-end) + ${String(room)}px)` } : {}}
      className="relative min-h-0 flex-1 overflow-y-auto px-5 pt-6 pb-(--form-body-end) [--form-body-end:2rem] md:px-8 md:pt-8 md:[--form-body-end:2.5rem]"
    >
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  );
}

/** Whether the sheet's commit, or the caller's own call, is in flight, for a control in its body. */
const FormSheetBusy = createContext(false);

/**
 * True while the Form sheet around the caller holds: its commit runs, or the
 * caller reports its own call pending. A body control that acts on its own
 * (Archive) disables with it, so it cannot run while a Save is in flight.
 */
export function useFormSheetBusy(): boolean {
  return useContext(FormSheetBusy);
}

export type FormSheetProps = {
  open: boolean;
  /** Called when the operator backs out, or after the commit returns or resolves. */
  onClose: () => void;
  /** Names the form: "File a seed", "New project", "Launch in T3". */
  title: string;
  /**
   * The record the form acts on, under the title, only when it edits or acts on
   * an existing one: "Project key `MMR`", "`MMR-743` Form sheet pattern".
   */
  context?: ReactNode;
  /** Names what the commit does: "File seed", "Create project", "Save", "Launch". */
  commitLabel: string;
  /**
   * Sends the form. A host call returns its promise (a mutation's
   * `mutateAsync`); it must not reopen this sheet before it returns.
   */
  onCommit: () => void | Promise<void>;
  /** The form cannot be sent yet: its required fields are empty. */
  commitDisabled?: boolean;
  /** A call the caller runs is in flight (such as Archive): the commit disables and the sheet holds. */
  pending?: boolean;
  /** One line on what the commit leads to; it sits with the commit and describes it. */
  note?: ReactNode;
  /** The field focus starts on, when it is not the first (Seed, after Kind). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Where focus goes on close, for an opener that is not a trigger the sheet knows. */
  finalFocus?: FinalFocus;
  /** The fields, in order: FormField, FormCheckRow, then any FormGroup. */
  children: ReactNode;
};

export function FormSheet({
  open,
  onClose,
  title,
  context,
  commitLabel,
  onCommit,
  commitDisabled = false,
  pending = false,
  note,
  initialFocus,
  finalFocus,
  children,
}: FormSheetProps) {
  const desktop = useDrawerSide() === 'right';
  const returnTo = useFinalFocus(open, finalFocus);
  const { busy, commit } = useOpening(open, pending, commitDisabled);
  const body = useRef<HTMLDivElement>(null);
  const commitButton = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const [scrolled, setScrolled] = useState(false);

  const send = () => {
    if (busy || commitDisabled) {
      return;
    }
    void commit(commitButton.current, onCommit, onClose);
  };

  const firstField = () => {
    const named = initialFocus?.current;
    if (named !== null && named !== undefined) {
      return named;
    }
    return body.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
  };

  return (
    <Drawer
      open={open}
      onOpenChange={(next, details) => {
        if (next) {
          return;
        }
        if (busy) {
          details.cancel();
        } else {
          onClose();
        }
      }}
    >
      <DrawerBackdrop />
      <DrawerContent
        size="form"
        initialFocus={firstField}
        finalFocus={returnTo}
        className="gap-0 overflow-hidden p-0 data-[side=bottom]:pb-0"
      >
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <header
            data-slot="form-sheet-header"
            data-scrolled={scrolled ? '' : undefined}
            className="relative z-10 flex shrink-0 items-start gap-3 border-b border-line bg-well-850 pt-[calc(1.25rem+env(safe-area-inset-top))] pr-2 pb-5 pl-5 transition-shadow data-[scrolled]:elevation-edge md:pt-7 md:pr-6 md:pl-8"
          >
            <div className="min-w-0 flex-1">
              <DrawerTitle className="text-header leading-7 font-semibold tracking-[-0.01em] text-ink-bright">
                {title}
              </DrawerTitle>
              {context !== undefined && (
                <DrawerDescription className="mt-1 text-meta leading-5 text-ink-dim [&_.font-mono]:text-inherit">
                  {context}
                </DrawerDescription>
              )}
            </div>
            <button
              type="button"
              aria-label="Close"
              disabled={busy}
              onClick={onClose}
              className="-my-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-line hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 md:-my-1 md:size-9"
            >
              <CloseIcon className="size-5 md:size-[18px]" />
            </button>
          </header>
          <FormBody body={body} onScrolled={setScrolled}>
            <FormSheetBusy.Provider value={busy}>{children}</FormSheetBusy.Provider>
          </FormBody>
          <div
            data-slot="form-sheet-footer"
            className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-well-850 px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:flex-nowrap md:justify-end md:px-8 md:py-4"
          >
            {note !== undefined && (
              <p
                id={noteId}
                className="basis-full text-meta leading-5 text-ink-dim md:mr-auto md:basis-auto md:pr-4"
              >
                {note}
              </p>
            )}
            {desktop && (
              <ActionButton size="form" variant="formOutline" disabled={busy} onClick={onClose}>
                Cancel
              </ActionButton>
            )}
            <ActionButton
              ref={commitButton}
              type="submit"
              size="form"
              aria-busy={busy}
              aria-describedby={note === undefined ? undefined : noteId}
              disabled={busy || commitDisabled}
              className="max-md:flex-1"
            >
              {commitLabel}
            </ActionButton>
          </div>
        </form>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * A number that changes each time `open` turns true. A form keys its fields'
 * state by it, so each opening starts fresh even when its sheet stays mounted.
 */
export function useFormOpening(open: boolean): number {
  const [seen, setSeen] = useState({ count: open ? 1 : 0, open });
  if (seen.open !== open) {
    setSeen({ count: open ? seen.count + 1 : seen.count, open });
  }
  return open && !seen.open ? seen.count + 1 : seen.count;
}

/**
 * Asks the sheet's form to send itself, as Enter in a field does: the Seed's
 * Enter files. A form that cannot be sent ignores it.
 */
export function requestFormCommit(from: HTMLElement) {
  const form = from.closest('form');
  form?.requestSubmit();
}

export type FormFieldProps = {
  label: string;
  /** Marks the field optional, beside its label. A required field has no marker. */
  optional?: boolean;
  /** Help, only for a surprising input: a format, or behavior its label does not say. */
  help?: ReactNode;
  /** The control: FormTextInput, FormTextArea, a Select, or a Segmented Control. */
  children: ReactNode;
  className?: string;
};

/**
 * One field: its label (14/20 ink 500), its control 8 below, and its help 8
 * below that (13/20 ink-dim, at most 440 wide). Fields sit 24 apart.
 */
export function FormField({ label, optional = false, help, children, className }: FormFieldProps) {
  return (
    <Field {...BLOCK_PROPS} className={cn(BLOCK_PROPS.className, className)}>
      <FieldLabel className="flex items-baseline">
        {label}
        {optional && <FieldOptional />}
      </FieldLabel>
      {children}
      {help !== undefined && <FieldDescription>{help}</FieldDescription>}
    </Field>
  );
}

/** A one-line text box at the control height. */
export function FormTextInput(props: ComponentProps<typeof Input>) {
  return <Input {...props} />;
}

/** A text box three lines tall that grows by its corner. */
export function FormTextArea(props: ComponentProps<typeof Textarea>) {
  return <Textarea {...props} />;
}

/**
 * A lone checkbox row ("Plan first"): 44 tall on a phone and 36 from `md` up,
 * its extra height pulled back so its text sits 24 below the control above.
 */
export function FormCheckRow({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div
      {...BLOCK_PROPS}
      className={cn(
        BLOCK_PROPS.className,
        '-my-[11px] flex min-h-11 items-center gap-3 md:-my-[7px] md:min-h-9',
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => {
          onCheckedChange(next === true);
        }}
        className="bg-well-950"
      />
      <label htmlFor={id} className="text-[15px] leading-[22px] text-ink-bright">
        {label}
      </label>
    </div>
  );
}

export type FormGroupProps = {
  title: string;
  /** A paragraph under the heading, at the form's prose measure (Lifecycle's). */
  explanation?: ReactNode;
  /** The explanation's id, so a control in the group (Archive) can be described by it. */
  explanationId?: string;
  /** Folds the group behind its heading, closed at first: rarely used settings (Advanced). */
  collapsible?: boolean;
  children?: ReactNode;
};

/**
 * A group of fields at the end of the body: 32 below the last field, a `line`
 * hairline, then 24 to its 16/600 heading. A destructive or lifecycle group
 * (Archive) is the last one, in DOM order as on screen.
 */
export function FormGroup({
  title,
  explanation,
  explanationId,
  collapsible = false,
  children,
}: FormGroupProps) {
  const ownId = useId();
  const proseId = explanationId ?? ownId;
  const heading = 'text-base leading-6 font-semibold text-ink-bright';
  const prose =
    explanation === undefined ? null : (
      <p id={proseId} className={cn(FORM_PROSE_CLASS, '-mt-2')}>
        {explanation}
      </p>
    );
  if (collapsible) {
    return (
      <Collapsible className="mt-2 border-t border-line pt-6">
        <div {...BLOCK_PROPS}>
          <CollapsibleTrigger
            chevron="end"
            className={cn(
              heading,
              '-my-2.5 min-h-11 w-auto py-0 hover:text-ink-bright md:-my-1.5 md:min-h-9',
            )}
          >
            {title}
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <div className="flex flex-col gap-6 pt-5">
            {prose}
            {children}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    );
  }
  return (
    <section
      aria-labelledby={`${proseId}-heading`}
      className="mt-2 flex flex-col gap-5 border-t border-line pt-6"
    >
      <h3 {...BLOCK_PROPS} id={`${proseId}-heading`} className={cn(BLOCK_PROPS.className, heading)}>
        {title}
      </h3>
      {prose}
      {children}
    </section>
  );
}
