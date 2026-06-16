import type { WireTreeNode } from "../api/types";

/**
 * Map every node id → a breadcrumb of its ancestor titles within the project,
 * `initiative › phase` style (the project root itself is excluded — the board
 * is already per-project). A task under a phase reads `Build › Phase 5`; a
 * task directly under an initiative reads `Build`; an initiative reads `""`.
 */
export function buildAncestry(root: WireTreeNode): Map<string, string> {
  const labels = new Map<string, string>();
  const walk = (node: WireTreeNode, chain: readonly string[]): void => {
    labels.set(node.id, chain.join(" › "));
    for (const child of node.children) {
      walk(child, [...chain, node.title]);
    }
  };
  // Start below the root so the project name never appears in a breadcrumb.
  for (const child of root.children) {
    walk(child, []);
  }
  return labels;
}
