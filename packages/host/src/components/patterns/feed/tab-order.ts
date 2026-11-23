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
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(', ');

/** Whether Tab can land on `element`: in the sequence, enabled, not inert, and shown (visibility:hidden counts as hidden). */
function reachable(element: HTMLElement): boolean {
  return (
    element.tabIndex >= 0 &&
    !element.matches(':disabled') &&
    element.closest('[inert]') === null &&
    element.checkVisibility({ visibilityProperty: true })
  );
}

/**
 * The controls under `root` that Tab reaches, in the browser's order: positive
 * `tabindex` values first, ascending, then the rest in document order.
 */
export function tabSequence(root: ParentNode): HTMLElement[] {
  const reached = [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(reachable);
  const positive = reached
    .filter((element) => element.tabIndex > 0)
    .toSorted((a, b) => a.tabIndex - b.tabIndex);
  return [...positive, ...reached.filter((element) => element.tabIndex === 0)];
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
  const all = tabSequence(from.ownerDocument).filter(
    (element) => element === from || skip?.contains(element) !== true,
  );
  const index = all.indexOf(from);
  return index === -1 ? null : (all[index + (backward ? -1 : 1)] ?? null);
}
