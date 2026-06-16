import type { WireTreeNode } from "../api/types";

export interface ParentOption {
  id: string;
  label: string;
  depth: number;
  type: "initiative" | "phase";
}

/** Valid task parents in tree order: initiatives (depth 0) and their phases (depth 1). */
export function parentOptions(root: WireTreeNode): ParentOption[] {
  const out: ParentOption[] = [];
  for (const initiative of root.children) {
    if (initiative.type !== "initiative") continue;
    out.push({ id: initiative.id, label: initiative.title, depth: 0, type: "initiative" });
    for (const phase of initiative.children) {
      if (phase.type !== "phase") continue;
      out.push({ id: phase.id, label: phase.title, depth: 1, type: "phase" });
    }
  }
  return out;
}
