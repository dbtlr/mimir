import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/*
 * How a sheet's scrolling body rests (DESIGN.md, Sheets, panels, dialogs),
 * shared by the Form sheet and the preview panel. A scroll the operator leaves
 * mid-way stays where it is; the body adds bottom room so the natural end of
 * its scroll lands on a clean rest, and a control the keyboard focuses out of
 * view scrolls to a rest that shows it whole. It does not snap.
 */

/** The field gap: a resting scroll keeps this much between the header and the first label. */
const FIELD_GAP = 24;

/**
 * A block's visible extent in the body's scroll space: its box less the
 * height a negative margin pulls back (a check row's or a collapsible
 * heading's tap row), so the rests measure its text, not its tap row.
 */
export type BlockExtent = { top: number; bottom: number };

/**
 * The scroll positions where the body rests cleanly, one per block: the block
 * a field gap below the header, or lower when that would leave a sliver of the
 * block above it showing (a heading 20 above its first label). A block that
 * opens the body, at its top padding (`topPadding`), rests at the top, so the
 * first field keeps that padding (24 on a phone, 32 from `md` up). When content
 * that is not a block follows the last one (`contentFollows`: Lifecycle's
 * explanation and Archive), the scroll that hides that last block whole is a
 * rest too.
 */
export function restsOf(
  blocks: readonly BlockExtent[],
  contentFollows: boolean,
  topPadding = 0,
): number[] {
  const rests: number[] = [];
  let above = Number.NEGATIVE_INFINITY;
  for (const block of blocks) {
    const opensBody = rests.length === 0 && block.top <= topPadding + 0.5;
    rests.push(opensBody ? 0 : Math.max(block.top - FIELD_GAP, above));
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

/**
 * Where a body's first view ends when its blocks run past the room it has
 * (`available`, in the body's scroll space): a field gap below the last block
 * that fits whole with that gap, so no bar cuts a block and the next one
 * starts just past the view. Undefined when not even the first block fits.
 */
export function firstViewEnd(
  blocks: readonly BlockExtent[],
  available: number,
): number | undefined {
  const last = blocks.findLast((block) => block.bottom + FIELD_GAP <= available + 0.5);
  return last === undefined ? undefined : Math.floor(last.bottom + FIELD_GAP);
}

/** Where a newly focused control sits in the body's scroll space. */
export type FocusedPlace = {
  /** The rest of the block (the field) that holds it, or a field gap above the control when none does. */
  rest: number;
  /** The top of the field that holds it (its label), or the control's own top when no field holds it. */
  fieldTop: number;
  /** The control's edges, its outline included. */
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
  /**
   * The clearance above the footer a control already in view needs to stay where it is: none
   * for a focus that just moved, which stays wherever its field shows whole, and the end
   * padding for a keyboard focus whose body resized under it.
   */
  holdClearance: number;
  /** Every rest, from `restsOf`. */
  rests: readonly number[];
};

/**
 * The scroll that brings a newly focused control's field fully into view, or
 * `null` when it already is (WCAG 2.4.11): its label and its control, outline
 * and all, clear of the footer by `holdClearance`. A field taller than the body
 * need only show its control. Otherwise it lands on a rest that shows the
 * whole field: its block a field gap below the header, the control clear of
 * the footer by the body's end padding. The rests are the top, each block's,
 * and the end, and the nearest to the current scroll wins. When no rest holds
 * the field, it scrolls the least that shows it whole, with the end padding
 * when both fit. When even the control is taller than the body, it shows its top.
 */
export function focusScroll(place: FocusedPlace, scroll: BodyScroll): number | null {
  const { scrollTop, clientHeight, maxScroll, endClearance, holdClearance, rests } = scroll;
  const { rest: own, fieldTop, controlTop, controlBottom } = place;
  const top =
    controlBottom - fieldTop <= clientHeight ? Math.min(fieldTop, controlTop) : controlTop;
  const clearance = controlBottom - controlTop + holdClearance <= clientHeight ? holdClearance : 0;
  if (top >= scrollTop - 0.5 && controlBottom + clearance <= scrollTop + clientHeight + 0.5) {
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
  const start = low <= Math.min(top, maxScroll) ? low : least;
  return clamp(Math.min(Math.max(scrollTop, start), top));
}

/**
 * The popups a body control opens inside the body's DOM: a Select's list
 * (a top-layer popover on a phone), a Record picker's popup, a menu, or a
 * dialog nested in the sheet. Focus inside one moves nothing in the body.
 */
const POPUP_SELECTOR = [
  '[data-slot=select-viewport]',
  '[data-slot=select-content]',
  '[data-slot=combobox-content]',
  '[data-slot=popover-content]',
  '[data-slot=menu-content]',
  '[role=menu]',
  '[role=dialog]',
  '[role=alertdialog]',
].join(', ');

/** `element.matches`, false for a selector this DOM cannot parse (jsdom's `:popover-open`). */
function matchesSafely(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/** Whether focus at `focused` sits in a popup opened from the body, rather than on a body control. */
export function inPopup(focused: Element, body: Element): boolean {
  for (
    let node: Element | null = focused;
    node !== null && node !== body;
    node = node.parentElement
  ) {
    if (matchesSafely(node, POPUP_SELECTOR) || matchesSafely(node, ':popover-open')) {
      return true;
    }
  }
  return false;
}

/** The input that last came before a focus move: a key, a pointer press, or none yet. */
export type LastInput = 'key' | 'pointer' | null;

/**
 * Whether a focus move came from the keyboard, so the body may scroll for it.
 * A pointer press never counts, even on a text box that draws its ring for
 * any focus: the scroll would move the target out from under the pointer
 * before the release lands. A key counts, and so does a focus with no input
 * before it that the browser marks `:focus-visible` (focus returned in code).
 */
export function isKeyboardFocus(focused: Element, last: LastInput): boolean {
  if (last === 'pointer') {
    return false;
  }
  return last === 'key' || matchesSafely(focused, ':focus-visible');
}

/** How far a focused control's outline reaches past its box, in px: its width plus its offset. */
function ringReach(element: Element): number {
  const style = getComputedStyle(element);
  if (style.outlineStyle === '' || style.outlineStyle === 'none') {
    return 0;
  }
  const reach =
    Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset || '0');
  return Number.isNaN(reach) ? 0 : Math.max(0, reach);
}

/**
 * How the body keeps its focused control in view: `moved` for a keyboard focus
 * that just moved, which stays wherever its field shows whole and otherwise
 * rests clear of the footer by the end padding; `clear` for a keyboard focus
 * whose body resized, which also stays only that clear; `whole` for a pointer's
 * focus whose body resized, whose control need only show whole.
 */
type FocusKeep = 'moved' | 'clear' | 'whole';

/** A body's blocks, the extents and rests they make in its scroll space, and that space's origin. */
export type MeasuredRests = {
  blocks: readonly Element[];
  extents: readonly BlockExtent[];
  origin: number;
  rests: readonly number[];
};

/** Measures a body's blocks and their rests; each sheet knows its own blocks. */
export type MeasureRests = (element: HTMLElement) => MeasuredRests;

/**
 * Brings the body's focused control into view, outline and all, when focus
 * sits on a body control, as `keep` says.
 */
function keepFocusInView({
  element,
  room,
  keep,
  measure,
}: {
  element: HTMLElement;
  room: number;
  keep: FocusKeep;
  measure: MeasureRests;
}) {
  const focused = element.ownerDocument.activeElement;
  if (
    !(focused instanceof HTMLElement) ||
    focused === element ||
    !element.contains(focused) ||
    inPopup(focused, element)
  ) {
    return;
  }
  const { blocks, extents, origin, rests } = measure(element);
  const control = focused.getBoundingClientRect();
  const ring = ringReach(focused);
  const holder = blocks.findIndex((block) => block.contains(focused));
  const padding = Number.parseFloat(getComputedStyle(element).paddingBottom);
  const endClearance = Number.isNaN(padding) ? FIELD_GAP : padding - room;
  const controlTop = control.top - ring - origin;
  const field = keep === 'whole' ? undefined : extents[holder];
  const target = focusScroll(
    {
      controlBottom: control.bottom + ring - origin,
      controlTop,
      fieldTop: field?.top ?? controlTop,
      rest: rests[holder] ?? control.top - origin - FIELD_GAP,
    },
    {
      clientHeight: element.clientHeight,
      endClearance: keep === 'whole' ? 0 : endClearance,
      holdClearance: keep === 'clear' ? endClearance : 0,
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
 * Keeps a sheet's scrolling body resting cleanly (DESIGN.md, Sheets): it
 * returns the bottom room the body adds when the natural end of its scroll
 * would cut a block under the header, and when the keyboard moves focus to a
 * control whose field (label and control, outline and all) is not wholly in
 * view, it scrolls to the nearest rest that shows it whole; a field already in
 * view stays where it is. A pointer's focus, and focus inside a popup a control
 * opens, move nothing. It does not snap: a mandatory snap could rest the
 * focused field under a bar, and a scroll left mid-way stays where it is. The
 * body's one child is its content, which it measures as it resizes.
 */
export function useRestingBody({
  body,
  measure,
}: {
  body: RefObject<HTMLElement | null>;
  measure: MeasureRests;
}): number {
  const [room, setRoom] = useState(0);
  const roomRef = useRef(0);

  useLayoutEffect(() => {
    const element = body.current;
    if (element === null) {
      return undefined;
    }
    const owner = element.ownerDocument;
    // The input before each focus move, read on capture so a popup that stops a key still counts it.
    let lastInput: LastInput = null;
    // Whether the focused body control took focus from the keyboard, for a later resize.
    let keyboardFocus = false;
    // Whether a focus move is being dispatched, while the drawer's own reveal is dropped (below).
    let focusMoving = false;
    const onKey = () => {
      lastInput = 'key';
      focusMoving = false;
    };
    const onPointer = () => {
      lastInput = 'pointer';
      focusMoving = false;
    };
    // Focus moves before the browser scrolls it into view, so a control this
    // scroll shows whole needs no scroll of the browser's own. Focus inside a
    // popup moves nothing; focus back on its trigger takes the usual rule.
    const onFocusIn = (event: FocusEvent) => {
      const focused = event.target;
      if (!(focused instanceof Element)) {
        return;
      }
      if (inPopup(focused, element)) {
        return;
      }
      keyboardFocus = isKeyboardFocus(focused, lastInput);
      if (keyboardFocus) {
        keepFocusInView({ element, keep: 'moved', measure, room: roomRef.current });
      }
    };
    // The drawer reveals a newly focused control too, 16 from the body's edge and
    // smoothly, in the same focus dispatch: it would move a pressed control from under
    // the pointer and the form behind a popup. The rule above has decided that move, so
    // the body drops the drawer's scroll while focus moves, from the document's capture
    // of `focusin` to the window's, and takes it otherwise (a phone keyboard's rise).
    const startFocusMove = () => {
      focusMoving = true;
    };
    const endFocusMove = () => {
      focusMoving = false;
    };
    const view = owner.defaultView;
    Object.defineProperty(element, 'scrollBy', {
      configurable: true,
      value: (...args: unknown[]) => {
        if (!focusMoving) {
          // oxlint-disable-next-line typescript/unbound-method -- applied to the body itself
          Reflect.apply(Element.prototype.scrollBy, element, args);
        }
      },
    });
    owner.addEventListener('keydown', onKey, true);
    owner.addEventListener('pointerdown', onPointer, true);
    owner.addEventListener('mousedown', onPointer, true);
    owner.addEventListener('focusin', startFocusMove, true);
    view?.addEventListener('focusin', endFocusMove);
    element.addEventListener('focusin', onFocusIn);
    const stopListening = () => {
      owner.removeEventListener('keydown', onKey, true);
      owner.removeEventListener('pointerdown', onPointer, true);
      owner.removeEventListener('mousedown', onPointer, true);
      owner.removeEventListener('focusin', startFocusMove, true);
      view?.removeEventListener('focusin', endFocusMove);
      element.removeEventListener('focusin', onFocusIn);
      Reflect.deleteProperty(element, 'scrollBy');
    };
    if (typeof ResizeObserver === 'undefined') {
      return stopListening;
    }
    const onResize = () => {
      if (element.clientHeight === 0) {
        return;
      }
      const naturalEnd = element.scrollHeight - roomRef.current - element.clientHeight;
      const next = restingRoom(naturalEnd, measure(element).rests);
      if (next !== roomRef.current) {
        roomRef.current = next;
        setRoom(next);
      }
      // A body that shrinks (a phone's keyboard) or a field that grows keeps focus in view:
      // clear of the footer for a keyboard focus, and only whole for a pointer's.
      keepFocusInView({ element, keep: keyboardFocus ? 'clear' : 'whole', measure, room: next });
    };
    onResize();
    const observer = new ResizeObserver(onResize);
    observer.observe(element);
    const content = element.firstElementChild;
    if (content !== null) {
      observer.observe(content);
    }
    return () => {
      stopListening();
      observer.disconnect();
    };
  }, [body, measure]);

  return room;
}
