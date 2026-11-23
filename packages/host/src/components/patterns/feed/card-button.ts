/**
 * A card's own button, stacked over its stretched target, found from the card
 * or any element inside it. It is the action slot's first child, read
 * directly: jsdom's selector engine can miss `[data-slot] > *` scoped to an element.
 */
export function cardButton(within: Element | null | undefined): HTMLElement | null {
  const button = within?.querySelector('[data-slot="feed-card-action"]')?.firstElementChild;
  return button instanceof HTMLElement ? button : null;
}
