import type { WireTreeNode } from '../api/types';

/**
 * The containers above `id` in its project tree, outermost first, without the
 * project root — a record page's breadcrumb trail. Undefined when the tree
 * does not hold `id`.
 */
export function ancestorsOf(root: WireTreeNode, id: string): WireTreeNode[] | undefined {
  const walk = (node: WireTreeNode, path: WireTreeNode[]): WireTreeNode[] | undefined => {
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
export function subtreeOf(root: WireTreeNode, id: string): WireTreeNode | undefined {
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
