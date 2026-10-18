/** What the walks read off a tree: ids and the nested children. Any tree read satisfies it. */
type Tree<T> = { id: string; children: readonly T[] };

/**
 * The containers above `id` in its project tree, outermost first, without the
 * project root — a record page's breadcrumb trail. Undefined when the tree
 * does not hold `id`.
 */
export function ancestorsOf<T extends Tree<T>>(root: T, id: string): T[] | undefined {
  const walk = (node: T, path: T[]): T[] | undefined => {
    for (const child of node.children) {
      if (child.id === id) {
        return path;
      }
      const found = walk(child, [...path, child]);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(root, []);
}

/** The subtree rooted at `id`, or undefined when the tree does not hold it. */
export function subtreeOf<T extends Tree<T>>(root: T, id: string): T | undefined {
  if (root.id === id) {
    return root;
  }
  for (const child of root.children) {
    const found = subtreeOf(child, id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * The path an artifact's page runs through (MMR-452): the containers down to
 * the nearest record holding every linked record, outermost first, without
 * the project root. A lone record is its own end, so the path runs through
 * it; several stop at the deepest container they share, and a linked
 * container that holds the rest counts. Empty when only the project holds
 * them all; undefined when the tree cannot place every one of them.
 */
export function sharedPathOf<T extends Tree<T>>(root: T, ids: readonly string[]): T[] | undefined {
  let shared: T[] | undefined;
  for (const id of ids) {
    const above = ancestorsOf(root, id);
    const node = above === undefined ? undefined : subtreeOf(root, id);
    // A record the tree cannot place leaves the shared container unknown.
    if (above === undefined || node === undefined) {
      return undefined;
    }
    const chain = [...above, node];
    if (shared === undefined) {
      shared = chain;
      continue;
    }
    let common = 0;
    while (common < shared.length && shared[common]?.id === chain[common]?.id) {
      common += 1;
    }
    shared = shared.slice(0, common);
  }
  return shared;
}
