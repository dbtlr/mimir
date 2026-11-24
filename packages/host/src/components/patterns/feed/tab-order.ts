/** Everything that can sit in the tab order; `tabSequence` then drops what a negative `tabindex`, `inert`, or hiding takes out. */
const TABBABLE = [
  'a[href]',
  'area[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type=hidden])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'details > summary:first-of-type',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]',
  '[tabindex]',
].join(', ');

/** Whether `element` sits inside an editing host, where only the host is a tab stop. */
function insideEditor(element: HTMLElement): boolean {
  return element.parentElement?.isContentEditable === true;
}

/** An editing host (editable, its parent not), which is tabbable without a `tabindex`. */
function isEditingHost(element: HTMLElement): boolean {
  return element.isContentEditable && !insideEditor(element);
}

/** Whether `element` is shown: it has a box, and visibility:hidden counts as hidden. */
function shown(element: HTMLElement): boolean {
  // Safari before 17.4 has no checkVisibility.
  if (Reflect.has(element, 'checkVisibility')) {
    return element.checkVisibility({ visibilityProperty: true });
  }
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
}

/** Whether Tab can land on `element`: in the sequence, enabled, not inert, and shown. */
export function reachable(element: HTMLElement): boolean {
  const inSequence =
    element.tabIndex >= 0 || (!element.hasAttribute('tabindex') && isEditingHost(element));
  return (
    inSequence &&
    !insideEditor(element) &&
    !element.matches(':disabled') &&
    element.closest('[inert]') === null &&
    shown(element)
  );
}

/** A radio in a named group, which takes one tab stop. */
function isGroupedRadio(element: Element): element is HTMLInputElement {
  return element instanceof HTMLInputElement && element.type === 'radio' && element.name !== '';
}

/** Every radio in `radio`'s group: the same name in the same form, or in the same root outside any form. */
function radioGroup(radio: HTMLInputElement): HTMLInputElement[] {
  const scope = radio.form ?? radio.getRootNode();
  let candidates: Element[] = [radio];
  if (scope instanceof HTMLFormElement) {
    candidates = [...scope.elements];
  } else if (scope instanceof Document || scope instanceof ShadowRoot) {
    candidates = [...scope.querySelectorAll('input')];
  }
  return candidates.filter(
    (other): other is HTMLInputElement =>
      isGroupedRadio(other) && other.name === radio.name && other.form === radio.form,
  );
}

/**
 * The sequence with each radio group down to its one tab stop, as the browser
 * keeps it: the radio Tab moves from (`from`), else the checked one, else the
 * first the way Tab moves (the last for Shift+Tab).
 */
function oneStopPerGroup(
  sequence: readonly HTMLElement[],
  { backward, from }: { backward: boolean; from: HTMLElement | null },
): HTMLElement[] {
  return sequence.filter((element) => {
    if (!isGroupedRadio(element)) {
      return true;
    }
    const group: readonly Element[] = radioGroup(element);
    const members = sequence.filter((other) => group.includes(other));
    const stop =
      members.find((other) => other === from) ??
      radioGroup(element).find((other) => other.checked) ??
      (backward ? members.at(-1) : members[0]);
    return element === stop;
  });
}

/**
 * The controls under `root` that Tab reaches, in the browser's order: positive
 * `tabindex` values first, ascending, then the rest in document order. A radio
 * group keeps one stop, which depends on the way Tab moves (`backward`) and the
 * control it moves from (`from`).
 */
export function tabSequence(
  root: ParentNode,
  { backward = false, from = null }: { backward?: boolean; from?: HTMLElement | null } = {},
): HTMLElement[] {
  const reached = [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(reachable);
  const positive = reached
    .filter((element) => element.tabIndex > 0)
    .toSorted((a, b) => a.tabIndex - b.tabIndex);
  const ordered = [...positive, ...reached.filter((element) => element.tabIndex <= 0)];
  return oneStopPerGroup(ordered, { backward, from });
}

/** The control Tab reaches after `from` (before it, `backward`), outside `skip`. */
export function tabNeighbour({
  from,
  skip,
  backward = false,
}: {
  from: HTMLElement;
  skip: Element | null;
  backward?: boolean;
}): HTMLElement | null {
  const all = tabSequence(from.ownerDocument, { backward, from }).filter(
    (element) => element === from || skip?.contains(element) !== true,
  );
  const index = all.indexOf(from);
  return index === -1 ? null : (all[index + (backward ? -1 : 1)] ?? null);
}
