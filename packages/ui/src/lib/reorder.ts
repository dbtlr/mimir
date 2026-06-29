/** The body the `/reorder` route accepts (the before/after grammar). */
export type ReorderArgs = {
  before?: string;
  after?: string;
};

/**
 * Translate a sortable drop into a `reorder` call. `over` is the item currently
 * occupying the drop slot; moving down → land after it, moving up → land before
 * it. Returns null when nothing moved or an id is unknown.
 */
export function reorderArgs(
  activeId: string,
  overId: string,
  orderedIds: readonly string[],
): ReorderArgs | null {
  if (activeId === overId) {
    return null;
  }
  const from = orderedIds.indexOf(activeId);
  const to = orderedIds.indexOf(overId);
  if (from === -1 || to === -1) {
    return null;
  }
  return from < to ? { after: overId } : { before: overId };
}
