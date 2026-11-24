import { onlineManager } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
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
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { BLOCK_PROPS } from './form-block';
import { useFinalFocus } from './opener';
import type { FinalFocus } from './opener';
import { useOpening } from './opening';
import { RecordPicker } from './record-picker';
import { SHEET_FOOTER_CLASS, SheetBody, SheetClose } from './sheet-chrome';

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

/** What a control in the body can take focus as, for the default first-field focus. */
const FOCUSABLE =
  'input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The scrolling body, which rests by the Sheets rule (`useRestingBody`) over
 * the form's blocks. It mounts with the sheet's content, so it measures what
 * is shown, and reports whether it has scrolled, for the header's shadow.
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
  useEffect(() => {
    onScrolled(false);
  }, [onScrolled]);

  return (
    <SheetBody
      body={body}
      slot="form-sheet-body"
      onScroll={(event) => {
        onScrolled(event.currentTarget.scrollTop > 0);
      }}
    >
      {children}
    </SheetBody>
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
  /** Recheck an interlock at submit time, before a pending render can disable the button. */
  canCommit?: () => boolean;
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

const subscribeOnline = (onChange: () => void) => onlineManager.subscribe(onChange);
const isOnline = () => onlineManager.isOnline();

export function FormSheet({
  open,
  onClose,
  title,
  context,
  commitLabel,
  onCommit,
  commitDisabled = false,
  canCommit,
  pending = false,
  note,
  initialFocus,
  finalFocus,
  children,
}: FormSheetProps) {
  const desktop = useDrawerSide() === 'right';
  const returnTo = useFinalFocus(open, finalFocus);
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  const disabled = commitDisabled || !online;
  const { busy, commit } = useOpening(open, pending, disabled);
  const body = useRef<HTMLDivElement>(null);
  const commitButton = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const [scrolled, setScrolled] = useState(false);

  const send = () => {
    if (busy || disabled || !isOnline() || canCommit?.() === false) {
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
            <SheetClose disabled={busy} onClick={onClose} className="-my-2 md:-my-1" />
          </header>
          <FormBody body={body} onScrolled={setScrolled}>
            <FormSheetBusy.Provider value={busy}>{children}</FormSheetBusy.Provider>
          </FormBody>
          <div data-slot="form-sheet-footer" className={SHEET_FOOTER_CLASS}>
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
              disabled={busy || disabled}
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
 * Asks the sheet's form to send itself, as Enter in a field does: the Seed's
 * Enter files. A form that cannot be sent ignores it.
 */
export function requestFormCommit(from: HTMLElement) {
  const form = from.closest('form');
  form?.requestSubmit();
}

export type FormFieldProps = {
  label: string;
  /** Disable a Select or Segmented Control while the form holds a commit. */
  choice?: boolean;
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
export function FormField({
  label,
  choice = false,
  optional = false,
  help,
  children,
  className,
}: FormFieldProps) {
  const busy = useFormSheetBusy();
  return (
    <Field
      {...BLOCK_PROPS}
      disabled={choice && busy}
      className={cn(BLOCK_PROPS.className, className)}
    >
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
export function FormTextInput({ readOnly, ...props }: ComponentProps<typeof Input>) {
  const busy = useFormSheetBusy();
  return <Input {...props} readOnly={busy || readOnly} />;
}

/**
 * A text box three lines tall that scrolls past them. It draws no resize grip:
 * the grip, a browser's own mark in the control's corner, reads as stray on a
 * sheet whose width is fixed.
 */
export function FormTextArea({ className, readOnly, ...props }: ComponentProps<typeof Textarea>) {
  const busy = useFormSheetBusy();
  return (
    <Textarea {...props} readOnly={busy || readOnly} className={cn('resize-none', className)} />
  );
}

/** A record picker that holds its selection while the sheet commits. */
export function FormRecordPicker({ disabled, ...props }: ComponentProps<typeof RecordPicker>) {
  const busy = useFormSheetBusy();
  return <RecordPicker {...props} disabled={busy || disabled} />;
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
  const busy = useFormSheetBusy();
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
        disabled={busy || disabled}
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
