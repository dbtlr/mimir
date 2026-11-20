import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode, RefObject } from 'react';

import { cn } from '../../lib/cn';
import {
  Combobox,
  ComboboxButton,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '../ui/combobox';
import {
  Command,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Dialog, DialogBackdrop, DialogClose, DialogContent } from '../ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { BLOCK_PROPS } from './form-block';
import { useFinalFocus } from './opener';
import type { FinalFocus } from './opener';

/*
 * Record picker (ADR 0019, MMR-736): use it to pick a record found by search,
 * never a Choice. Three shapes share the one look (Listbox's rows):
 *
 * - `RecordPicker`, a form's field: a 44px control showing the chosen record's
 *   key and title, which opens a Combobox popup with its search box inside.
 * - `RecordPickerPopup`, a picker anchored to a header button (the project
 *   switcher), for a list that keeps its own keyboard model.
 * - `RecordPalette`, the jump palette: Command in a Dialog, searched by the
 *   caller (debounced, on the server) and run by Enter or a click.
 */

/** A record a picker offers: its key (mono) and its title (sans). */
export type PickerRecord = { id: string; title: string };

export type RecordPickerProps = {
  /** The field's label, which names the control. */
  label: string;
  records: readonly PickerRecord[];
  value: string | null;
  onValueChange: (id: string) => void;
  /** What the closed control reads before a record is chosen: "Choose a project…". */
  placeholder: string;
  /** Names the search box inside the popup. */
  searchLabel: string;
  /** The line shown when nothing matches the search. */
  emptyText: string;
  disabled?: boolean;
};

/** Narrows records by key or title, ignoring case. */
function matches(record: PickerRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return (
    needle === '' ||
    record.id.toLowerCase().includes(needle) ||
    record.title.toLowerCase().includes(needle)
  );
}

/** A record's key and title, as the source shows them: "`MMR` — Mimir". */
function RecordValue({ record }: { record: PickerRecord }) {
  return (
    <>
      <span className="font-mono [font-size-adjust:var(--mono-adjust)]">{record.id}</span> —{' '}
      {record.title}
    </>
  );
}

export function RecordPicker({
  label,
  records,
  value,
  onValueChange,
  placeholder,
  searchLabel,
  emptyText,
  disabled = false,
}: RecordPickerProps) {
  const labelId = useId();
  const valueId = useId();
  const [query, setQuery] = useState('');
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const chosen = records.find((record) => record.id === value);
  const shown = records.filter((record) => matches(record, query));
  return (
    <div {...BLOCK_PROPS} className={cn(BLOCK_PROPS.className, 'flex flex-col gap-2')}>
      <span id={labelId} className="text-label font-medium text-ink">
        {label}
      </span>
      <Combobox
        value={value}
        disabled={disabled}
        filter={false}
        autoHighlight
        query={query}
        onQueryChange={(next) => {
          setQuery(next);
        }}
        onOpenChange={(open) => {
          if (open) {
            setQuery('');
          }
        }}
        onOpenChangeComplete={(open) => {
          if (!open) {
            button?.focus();
          }
        }}
        itemToLabel={(id) => records.find((record) => record.id === id)?.title ?? id}
        onValueChange={(next) => {
          if (typeof next === 'string') {
            onValueChange(next);
          }
        }}
      >
        {/* Named by its label and the value it shows, so a screen reader hears the choice. */}
        <ComboboxButton
          ref={setButton}
          aria-labelledby={`${labelId} ${valueId}`}
          aria-haspopup="listbox"
        >
          {chosen === undefined ? (
            <span id={valueId} className="text-ink-dim">
              {placeholder}
            </span>
          ) : (
            <span id={valueId}>
              <RecordValue record={chosen} />
            </span>
          )}
        </ComboboxButton>
        <ComboboxContent
          anchor={button}
          className="w-(--anchor-width) gap-1 border-ink-faint bg-well-800 p-1 light:shadow-menu"
        >
          <ComboboxInput
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the search box takes focus as the popup opens
            autoFocus
            aria-label={searchLabel}
            placeholder={searchLabel}
            className="min-h-10 pr-3"
          />
          <ComboboxEmpty>{shown.length === 0 ? emptyText : null}</ComboboxEmpty>
          <ComboboxList>
            {shown.map((record) => (
              <ComboboxItem
                key={record.id}
                value={record.id}
                label={record.title}
                className="min-h-9 text-[15px] leading-[22px] max-md:min-h-11"
              >
                <span className="min-w-12 shrink-0 font-mono text-ink-dim [font-size-adjust:var(--mono-adjust)]">
                  {record.id}
                </span>
                <span className="min-w-0 flex-1 truncate">{record.title}</span>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

export type RecordPickerPopupProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The header button that opens it; it shows the current record. */
  trigger: ReactElement;
  /** The search box the popup opens on. */
  initialFocus: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
};

/**
 * A picker anchored to its header button, for a list with its own keyboard
 * model: the project switcher's pins, archive fold, and All projects row. The
 * popup is non-modal, opens on its search box, closes on Escape or an outside
 * press, and returns focus to the button.
 */
export function RecordPickerPopup({
  open,
  onOpenChange,
  trigger,
  initialFocus,
  className,
  children,
}: RecordPickerPopupProps) {
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent
        align="start"
        initialFocus={() => initialFocus.current}
        // Escape closes this popup alone, not a sheet or drawer that holds it (the phone's
        // project drawer): it stops here once the popup has taken it.
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
          }
        }}
        className={cn('w-[min(360px,calc(100vw-2rem))] bg-well-850 light:shadow-menu', className)}
      >
        {open && children}
      </PopoverContent>
    </Popover>
  );
}

const NO_HINTS: readonly string[] = [];

/** One row of a palette: a record to open or an action to run. */
export type PaletteChoice = {
  key: string;
  /** Runs the row; `newTab` asks a record to open in a new browser tab (Ctrl or ⌘). */
  run: (newTab: boolean) => void;
  content: ReactNode;
};

export type PaletteGroup = { label: string; count?: number; choices: PaletteChoice[] };

export type RecordPaletteProps = {
  open: boolean;
  onClose: () => void;
  /** Names the dialog and its search box. */
  label: string;
  query: string;
  onQueryChange: (query: string) => void;
  /** The rows, grouped; the caller searches, so they are shown as given. */
  groups: PaletteGroup[];
  /**
   * The rows answer an older query: Enter waits for the fresh rows and a click
   * on a row does nothing, so neither opens what the old query found.
   */
  waiting?: boolean;
  /** A line under the rows, such as "No records match" or a failed search. */
  notice?: ReactNode;
  /** The key hints under the results, on a desktop. */
  hints?: readonly string[];
  /** Runs once the palette has finished closing, for an action that opens its own dialog. */
  onClosed?: () => void;
  finalFocus?: FinalFocus;
};

/**
 * The jump palette's Record picker: a search box over grouped rows, Command in
 * a Dialog. A centred box from `md` up and the whole screen on a phone, where a
 * Cancel closes it. The first row is highlighted, and the highlight follows its
 * row while results refresh.
 */
export function RecordPalette({
  open,
  onClose,
  label,
  query,
  onQueryChange,
  groups,
  waiting = false,
  notice,
  hints = NO_HINTS,
  onClosed,
  finalFocus,
}: RecordPaletteProps) {
  const returnTo = useFinalFocus(open, finalFocus);
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) {
          onClosed?.();
        }
      }}
    >
      <DialogBackdrop />
      <DialogContent
        aria-label={label}
        initialFocus={() => input.current}
        finalFocus={returnTo}
        className="inset-0 top-0 left-0 h-dvh max-h-none w-full translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 bg-well-850 p-0 md:inset-auto md:top-16 md:left-1/2 md:h-auto md:max-h-[min(560px,80dvh)] md:w-[min(620px,calc(100vw-2rem))] md:-translate-x-1/2 md:rounded-2xl md:border md:border-line-bright light:md:shadow-overlay"
      >
        {open && (
          <PaletteBody
            label={label}
            input={input}
            query={query}
            onQueryChange={onQueryChange}
            groups={groups}
            waiting={waiting}
            notice={notice}
            hints={hints}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({
  label,
  input,
  query,
  onQueryChange,
  groups,
  waiting,
  notice,
  hints,
}: Pick<RecordPaletteProps, 'label' | 'query' | 'onQueryChange' | 'groups' | 'notice'> & {
  input: RefObject<HTMLInputElement | null>;
  waiting: boolean;
  hints: readonly string[];
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const shown = groups.filter((group) => group.choices.length > 0);
  const choices = shown.flatMap((group) => group.choices);
  // The highlight follows its row while results refresh, and falls back to the first.
  const active = choices.find((choice) => choice.key === activeKey) ?? choices[0];

  // Enter pressed while waiting is held for the fresh rows. The value is its new-tab flag.
  const heldEnter = useRef<boolean | null>(null);
  const runHeldEnter = useEffectEvent(() => {
    const newTab = heldEnter.current;
    heldEnter.current = null;
    if (newTab !== null) {
      active?.run(newTab);
    }
  });
  useEffect(() => {
    if (!waiting) {
      runHeldEnter();
    }
  }, [waiting]);

  function holdEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || !waiting) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    heldEnter.current = event.metaKey || event.ctrlKey;
  }

  return (
    <Command
      filter={false}
      loop
      value={active?.key ?? null}
      onValueChange={(next) => {
        setActiveKey(next);
      }}
      query={query}
      onQueryChange={(next) => {
        onQueryChange(next);
        setActiveKey(null);
        heldEnter.current = null;
      }}
      className="min-h-0 flex-1"
    >
      {/* One rule under the search row, Cancel included; the input's own rule gives way to it. */}
      <div className="flex items-center border-b border-line">
        <div className="min-w-0 flex-1 [&>div]:border-b-0">
          <CommandInput
            ref={input}
            aria-label={label}
            placeholder={label}
            onKeyDownCapture={holdEnter}
            className="placeholder:text-ink-dim"
          />
        </div>
        <DialogClose className="mr-2 inline-flex min-h-11 items-center rounded px-2 text-meta text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent md:hidden">
          Cancel
        </DialogClose>
      </div>
      <CommandList
        aria-busy={waiting}
        className={cn('transition-opacity', waiting && 'opacity-60')}
      >
        {shown.map((group) => (
          <CommandGroup key={group.label} className="py-1">
            <CommandGroupLabel>
              {group.label}
              {group.count !== undefined && ` · ${String(group.count)}`}
            </CommandGroupLabel>
            {group.choices.map((choice) => (
              <CommandItem
                key={choice.key}
                value={choice.key}
                onSelect={(event) => {
                  event.preventDefault();
                  // A row left from the previous query opens nothing, as Enter would not.
                  if (waiting) {
                    return;
                  }
                  const modified =
                    (event instanceof MouseEvent || event instanceof globalThis.KeyboardEvent) &&
                    (event.metaKey || event.ctrlKey);
                  choice.run(modified);
                }}
              >
                {choice.content}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandEmpty className="hidden" />
      </CommandList>
      {notice !== undefined && <p className="px-4 py-3 text-meta text-ink-dim">{notice}</p>}
      {hints.length > 0 && (
        <CommandFooter className="max-md:hidden">
          {hints.map((hint) => (
            <span key={hint}>{hint}</span>
          ))}
        </CommandFooter>
      )}
    </Command>
  );
}
