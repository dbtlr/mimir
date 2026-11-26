import type { EngineTree } from '@mimir/contract';

import { ancestorsOf, subtreeOf } from './ancestry';
import { isFinishedStatus, tallyOf } from './work-page';
import type { ContainerTally } from './work-page';

/*
 * The sidebar's container list inside a project (ADR 0013, MMR-730
 * refinement): the same three parts at every level, a link to the parent, the
 * current container, then its child containers. A task is never a row; its
 * page shows the container that holds it.
 */

/** One container's row: its status dot, title, and tally. */
export type ContainerRow = {
  id: string;
  type: EngineTree['type'];
  title: string;
  status: EngineTree['status'];
  tally: ContainerTally;
};

/**
 * Where a project page sits: the project's own page, a page the project holds
 * that no node in its tree names (its Tasks, Seeds, or Artifacts list, a seed,
 * an artifact, or a delivery), or a node's page.
 */
export type ProjectPlace = { kind: 'project' } | { kind: 'held' } | { kind: 'node'; id: string };

/** The level above the current row: Home above a project, else the container that holds it. */
export type ContainerParent =
  | { kind: 'home' }
  | { kind: 'container'; id: string; title: string; type: EngineTree['type'] };

export type ContainerList = {
  parent: ContainerParent;
  current: ContainerRow;
  /** `page` when the page is the current container's own; `holds` when the container holds it. */
  mark: 'page' | 'holds';
  /** The live child containers, in tree order. */
  children: ContainerRow[];
  /** The child containers whose rollup is done or abandoned, in tree order, for one fold. */
  finished: ContainerRow[];
};

const isContainer = (node: EngineTree): boolean => node.type !== 'task';

function rowOf(node: EngineTree): ContainerRow {
  return {
    id: node.id,
    status: node.status,
    tally: tallyOf(node),
    title: node.title,
    type: node.type,
  };
}

/**
 * The container whose level the page shows, and whether the page is that
 * container's own: the project on its own pages, a container on its page, and
 * the container that holds a task on the task's page.
 */
function focusOf(
  tree: EngineTree,
  place: ProjectPlace,
): { node: EngineTree; mark: ContainerList['mark'] } {
  if (place.kind === 'project') {
    return { mark: 'page', node: tree };
  }
  const open = place.kind === 'node' ? subtreeOf(tree, place.id) : undefined;
  if (open === undefined) {
    return { mark: 'holds', node: tree };
  }
  if (isContainer(open)) {
    return { mark: 'page', node: open };
  }
  return { mark: 'holds', node: ancestorsOf(tree, open.id)?.at(-1) ?? tree };
}

function parentOf(tree: EngineTree, focus: EngineTree): ContainerParent {
  if (focus.id === tree.id) {
    return { kind: 'home' };
  }
  const holder = ancestorsOf(tree, focus.id)?.at(-1) ?? tree;
  return { id: holder.id, kind: 'container', title: holder.title, type: holder.type };
}

/** The sidebar's container list for a page in the project `tree`. */
export function containerListOf(tree: EngineTree, place: ProjectPlace): ContainerList {
  const { node, mark } = focusOf(tree, place);
  const kids = node.children.filter(isContainer).map(rowOf);
  return {
    children: kids.filter((row) => !isFinishedStatus(row.status)),
    current: rowOf(node),
    finished: kids.filter((row) => isFinishedStatus(row.status)),
    mark,
    parent: parentOf(tree, node),
  };
}
