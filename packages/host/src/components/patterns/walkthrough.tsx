import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { ComponentProps, MouseEvent, ReactNode, RefObject } from 'react';

import { cn } from '../../lib/cn';
import { useMediaQuery } from '../../lib/use-media-query';
import { ActionButton } from '../ui/action-button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../ui/dialog';
import { DRAWER_DESKTOP_QUERY } from '../ui/drawer';
import { iconButtonClass } from '../ui/icon-button';
import { CloseIcon } from '../ui/icons';
import { Radio, RadioGroup } from '../ui/radio';
import { Textarea } from '../ui/textarea';
import { useFinalFocus } from './opener';
import { useOpening } from './opening';

/** What a Walkthrough's parts share: whether a commit holds the layer, how to run one, and its heading. */
type WalkthroughState = {
  busy: boolean;
  commit: ReturnType<typeof useOpening>['commit'];
  heading: RefObject<HTMLHeadingElement | null>;
};

const WalkthroughContext = createContext<WalkthroughState | null>(null);

function useWalkthrough(): WalkthroughState {
  const state = useContext(WalkthroughContext);
  if (state === null) {
    throw new Error('A Walkthrough part renders inside a Walkthrough');
  }
  return state;
}

/** Whether a commit holds the Walkthrough: a part the feature builds disables while it does. */
export function useWalkthroughBusy(): boolean {
  return useWalkthrough().busy;
}

export type WalkthroughProps = {
  /** The header's title, which names the dialog. */
  title: ReactNode;
  /** "N of M", or the name of a step past the questions; none hides it. */
  progress?: string | null;
  /** The phone's segmented progress under the header; none hides it. */
  steps?: { count: number; current: number } | null;
  /** The Close icon button's name, such as "Close the walkthrough". */
  closeLabel: string;
  /** Close or Escape, unless a commit holds the layer. */
  onClose: () => void;
  /** A call the caller runs is in flight: commits, Back, and Close disable, and Escape holds. */
  pending?: boolean;
  /** Names the screen shown. When it changes, focus moves to the new screen's `WalkthroughHeading`. */
  screen: string;
  /** A standing state at the top of the layer, such as the offline notice. */
  banner?: ReactNode;
  /** Beside the screen from `md` up, such as a rail of the steps. */
  aside?: ReactNode;
  /** The screen: a `WalkthroughBody`, then a `WalkthroughBar`. */
  children: ReactNode;
};

/**
 * Walkthrough (ADR 0019, MMR-736 and MMR-703 refinements): use it for a
 * guided series of answers, one screen at a time. A Dialog that covers the
 * whole console at every width; the console beneath is inert. Each screen's
 * heading takes focus as it shows, never a commit, so a key held down writes
 * nothing. Answers are a `WalkthroughChoices` (Radio: the arrow keys move the
 * selection) and a `WalkthroughNote`. A `WalkthroughCommit` runs once at a
 * time; while its promise or the caller's `pending` call runs, Close, Back,
 * and Escape hold and the answers are read-only; a refusal returns focus to
 * the commit. Close returns focus to what had it before the layer opened.
 */
export function Walkthrough({
  title,
  progress,
  steps,
  closeLabel,
  onClose,
  pending = false,
  screen,
  banner,
  aside,
  children,
}: WalkthroughProps) {
  // The layer mounts open and closes by unmounting, so this is its one opening.
  const returnTo = useFinalFocus(true, undefined);
  const { busy, commit } = useOpening(true, pending);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
    // When the screen changes, its new heading takes focus.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);
  const holdsFocus = useHoldFocus(heading, busy);
  const header = useRef<HTMLElement | null>(null);
  useLayerTopBar(header);
  const state = useMemo(() => ({ busy, commit, heading }), [busy, commit]);
  return (
    <WalkthroughContext value={state}>
      <Dialog
        open
        modal
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
        <DialogContent
          ref={holdsFocus}
          size="full"
          initialFocus={() => heading.current}
          finalFocus={returnTo}
          className="gap-0 overflow-hidden p-0"
        >
          {banner}
          <header
            ref={header}
            className="flex items-center gap-3 border-b border-line bg-well-950 px-5 py-3 md:px-6"
          >
            <DialogClose aria-label={closeLabel} disabled={busy} className={iconButtonClass}>
              <CloseIcon />
            </DialogClose>
            <DialogTitle className="flex min-w-0 flex-1 items-baseline gap-2 text-base font-semibold text-ink-bright">
              {title}
            </DialogTitle>
            {progress !== null && progress !== undefined && (
              // On a phone the segmented bar shows the progress, and the title takes the room.
              <p
                className={cn(
                  'text-meta leading-5 font-semibold whitespace-nowrap text-attention-foreground',
                  steps !== null && steps !== undefined && 'max-md:sr-only',
                )}
              >
                {progress}
              </p>
            )}
          </header>
          {steps !== null && steps !== undefined && <StepBar {...steps} />}
          <div className="flex min-h-0 flex-1">
            {aside}
            <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          </div>
        </DialogContent>
      </Dialog>
    </WalkthroughContext>
  );
}

/**
 * Keeps focus in the layer when what held it leaves the screen, as when a
 * refresh drops the decision whose answers had focus: once the layer's content
 * changes and focus has fallen to the body, the screen's heading takes it.
 * While a commit runs, and until its refusal has given focus back to the
 * commit, it waits. Returns the ref callback for the layer's content.
 */
function useHoldFocus(heading: RefObject<HTMLHeadingElement | null>, busy: boolean) {
  const held = useRef(busy);
  // Passive, so it frees after the commit's own refocus effect, which useOpening runs first.
  useEffect(() => {
    held.current = busy;
  }, [busy]);
  return useCallback(
    (layer: HTMLElement | null) => {
      if (layer === null) {
        return undefined;
      }
      const doc = layer.ownerDocument;
      const observer = new MutationObserver(() => {
        const { activeElement, body } = doc;
        if (!held.current && (activeElement === null || activeElement === body)) {
          heading.current?.focus();
        }
      });
      observer.observe(layer, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
      };
    },
    [heading],
  );
}

/**
 * The name of the CSS variable that holds how far below the viewport's top
 * the open layer's header ends, its bottom hairline. NoticeHost places a
 * phone's Notice 8 below it, as it does below the console's top bar.
 */
export const LAYER_TOP_BAR_VARIABLE = '--layer-top-bar-height';

/** While the layer is open, sets `LAYER_TOP_BAR_VARIABLE` on the root from its header's measured bottom. */
function useLayerTopBar(header: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const node = header.current;
    if (node === null) {
      return undefined;
    }
    const root = node.ownerDocument.documentElement;
    const measure = () => {
      root.style.setProperty(
        LAYER_TOP_BAR_VARIABLE,
        `${String(node.getBoundingClientRect().bottom)}px`,
      );
    };
    measure();
    // The offline banner above the header moves it, so the whole layer is watched too.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.parentElement !== null) {
      observer.observe(node.parentElement);
    }
    return () => {
      observer.disconnect();
      root.style.removeProperty(LAYER_TOP_BAR_VARIABLE);
    };
  }, [header]);
}

/** The phone's progress: one segment for each step, done ones dimmer violet, the current one full. */
function StepBar({ count, current }: { count: number; current: number }) {
  return (
    <div aria-hidden className="flex gap-1 px-5 pt-3 md:hidden">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={cn(
            'h-1 flex-1 rounded-sm transition-colors',
            index < current && 'bg-attention/55',
            index === current && 'bg-attention',
            index > current && 'bg-well-800',
          )}
        />
      ))}
    </div>
  );
}

/** A screen's heading: it takes focus when the screen shows. */
export function WalkthroughHeading({ className, children, ...props }: ComponentProps<'h2'>) {
  const { heading } = useWalkthrough();
  return (
    <h2
      ref={heading}
      tabIndex={-1}
      className={cn(
        'text-header leading-7 font-bold tracking-[-0.01em] wrap-anywhere text-ink-bright outline-none',
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  );
}

/**
 * The scrolling body of a screen, above its bar, on the 600px measure. Its
 * text is prose, 14 / 23; a meta line in it sets its own 13 / 20.
 */
export function WalkthroughBody({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto px-5 pt-6 pb-8 md:px-12 md:pt-8 md:pb-10">
      <div className="flex flex-col text-body leading-[23px] md:max-w-[600px]">{children}</div>
    </div>
  );
}

/** The bar at the foot of a screen: a hairline above, the header's `line`, and the commit in it. */
export function WalkthroughBar({ children }: { children: ReactNode }) {
  return (
    <footer className="border-t border-line bg-well-950 px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:px-12 md:py-4">
      <div className="flex flex-col gap-2 md:max-w-[600px]">{children}</div>
    </footer>
  );
}

/**
 * A line of the bar above its row, in the meta voice: what the answer does,
 * or why the commit waits.
 */
export function WalkthroughBarLine({ children }: { children: ReactNode }) {
  return <p className="text-meta leading-5 text-pretty text-ink-dim">{children}</p>;
}

/**
 * A row of the bar: `back`, then the `note` when there is one, then the
 * commit (`children`), in that order in the DOM and on screen, so Tab
 * follows what the eye reads. From `md` up they share one row of three
 * columns. Below `md` the note is a row of its own, first, and the commit
 * fills the row under it beside Back. The two are different trees, chosen by
 * the breakpoint query, never reordered by CSS.
 */
export function WalkthroughRow({
  back,
  note,
  children,
}: {
  back: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  const desktop = useMediaQuery(DRAWER_DESKTOP_QUERY);
  if (desktop) {
    return (
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-2">
        {back}
        {note}
        {children}
      </div>
    );
  }
  return (
    <>
      {note}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-2">
        {back}
        {children}
      </div>
    </>
  );
}

/** Back, an icon button with the 44px target; it holds while a commit runs. */
export function WalkthroughBack({ className, disabled, ...props }: ComponentProps<'button'>) {
  const { busy } = useWalkthrough();
  return (
    <button
      type="button"
      aria-label="Back"
      disabled={busy || disabled === true}
      className={cn(
        'inline-flex size-11 items-center justify-center rounded-lg text-ink inset-ring inset-ring-ink-faint hover:inset-ring-ink-dim hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <BackGlyph />
    </button>
  );
}

/** A left arrow on a 16px grid, in `currentColor`. */
function BackGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M13 8H3.5M7.5 4L3.5 8l4 4" />
    </svg>
  );
}

/** The screen's one solid action: full width beside Back below `md`, 220 wide in the third column from `md` up. */
const SOLID_CLASS = 'md:col-start-3 md:min-w-[220px]';

/**
 * A double click's second click lands on the next screen's button in the same
 * place, before the operator has seen that screen: it is not a press. A key's
 * activation has no click count (`detail` 0) and always counts.
 */
function isRepeatClick(event: MouseEvent<HTMLButtonElement>): boolean {
  return event.detail > 1;
}

export type WalkthroughCommitProps = Omit<ComponentProps<'button'>, 'onClick'> & {
  /**
   * Writes. A write returns its promise (a mutation's `mutateAsync`), which
   * holds the layer until it settles; a rejection keeps the screen and returns
   * dropped focus here. The caller's call reports why.
   */
  onCommit: () => void | Promise<void>;
  /** The label while the write runs, such as "Sending…"; it names the button then. */
  pendingLabel: ReactNode;
};

/**
 * The screen's one solid action when it writes: it runs once at a time, holds
 * the layer while it runs, and reads `pendingLabel` until it settles.
 */
export function WalkthroughCommit({
  className,
  disabled,
  onCommit,
  pendingLabel,
  children,
  ...props
}: WalkthroughCommitProps) {
  const { busy, commit } = useWalkthrough();
  return (
    <ActionButton
      size="form"
      aria-busy={busy}
      disabled={busy || disabled === true}
      className={cn(SOLID_CLASS, className)}
      onClick={(event) => {
        if (!isRepeatClick(event)) {
          void commit(event.currentTarget, onCommit, () => undefined);
        }
      }}
      {...props}
    >
      {busy ? pendingLabel : children}
    </ActionButton>
  );
}

/**
 * The screen's one solid action when it only moves on and writes nothing,
 * such as "Confirm and continue". Each press moves one screen, and the second
 * click of a double click is ignored; it holds while a commit runs.
 */
export function WalkthroughNext({
  className,
  disabled,
  onClick,
  ...props
}: ComponentProps<'button'>) {
  const { busy } = useWalkthrough();
  return (
    <ActionButton
      size="form"
      disabled={busy || disabled === true}
      className={cn(SOLID_CLASS, className)}
      onClick={(event) => {
        if (!isRepeatClick(event)) {
          onClick?.(event);
        }
      }}
      {...props}
    />
  );
}

/** One answer a `WalkthroughChoices` offers. */
export type WalkthroughChoice = {
  value: string;
  /** The option's text, which names its radio; flags beside it may join the name. */
  label: ReactNode;
  /** More about the option, under it: it describes the radio and is clamped until chosen. */
  detail?: ReactNode;
};

/**
 * The answers: a Radio group, one row per choice, whose arrow keys move the
 * selection. The whole row is the radio's label, so a tap anywhere on it, the
 * detail included, chooses it. Read-only while a commit runs.
 */
export function WalkthroughChoices({
  label,
  choices,
  value,
  onChange,
}: {
  /** Names the group, such as "Your answer to MMR-q7". */
  label: string;
  choices: readonly WalkthroughChoice[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { busy } = useWalkthrough();
  const group = useId();
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      readOnly={busy}
      onValueChange={(next) => {
        if (next !== null) {
          onChange(next);
        }
      }}
      // 20 below the prose above it, whether or not a why is there.
      className="mt-5 flex flex-col border-t border-line"
    >
      {choices.map((choice, index) => {
        const chosen = choice.value === value;
        const textId = `${group}-${String(index)}`;
        const detailId = `${textId}-detail`;
        const hasDetail = choice.detail !== undefined && choice.detail !== null;
        return (
          <label
            key={choice.value}
            className="flex min-h-11 cursor-pointer items-start gap-3 border-b border-line px-1 py-3 has-[:focus-visible]:rounded-md has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent md:min-h-9"
          >
            <Radio
              value={choice.value}
              aria-labelledby={textId}
              aria-describedby={hasDetail ? detailId : undefined}
              // The row draws the focus ring, so the radio's own would frame inside a frame.
              className="mt-[3px] focus-visible:outline-none"
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span
                id={textId}
                className={cn(
                  'flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[15px] leading-[22px] wrap-anywhere',
                  chosen ? 'text-ink-bright' : 'text-ink',
                )}
              >
                {choice.label}
              </span>
              {hasDetail && (
                <span
                  id={detailId}
                  className={cn(
                    'text-meta leading-5 whitespace-pre-line text-ink-dim wrap-anywhere',
                    !chosen && 'line-clamp-2 md:line-clamp-3',
                  )}
                >
                  {choice.detail}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </RadioGroup>
  );
}

/**
 * A text box for a note or an answer of the operator's own: one line tall,
 * growing to four lines, then scrolling (Textarea `grow`). Its label names it;
 * read-only while a commit runs.
 */
export function WalkthroughNote({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { busy } = useWalkthrough();
  return (
    <Textarea
      grow
      aria-label={label}
      placeholder={placeholder}
      value={value}
      readOnly={busy}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
