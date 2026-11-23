const TABBABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The controls under `root` that Tab reaches, in document order: in the sequence, not inert, and shown. */
export function tabSequence(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      element.tabIndex >= 0 && element.closest('[inert]') === null && element.checkVisibility(),
  );
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
