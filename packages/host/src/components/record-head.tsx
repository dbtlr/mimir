import type { EngineTree } from '@mimir/contract';
import type { Ref } from 'react';

import { ancestorsOf } from '../lib/ancestry';
import { nodeLink } from '../lib/record-url';
import { ActionMenu } from './patterns/action-menu';
import type { ActionMenuAction, ActionMenuEntry } from './patterns/action-menu';
import type { TrailStep } from './patterns/record-header';
import { ActionButton } from './ui/action-button';
import { ChevronDownIcon } from './ui/icons';

/*
 * What every record page hands the record header (ADR 0019, MMR-726): its
 * trail, its type in words, and More.
 */

/** A record's type as its header's status line names it. */
export const RECORD_TYPE_LABEL = {
  initiative: 'Initiative',
  phase: 'Phase',
  project: 'Project',
  task: 'Task',
} as const;

/**
 * The trail above a work node: its project, then each container down to its
 * parent. Only the project while the tree has not arrived or cannot place the node.
 */
export function recordTrail(
  projectKey: string,
  tree: EngineTree | undefined,
  nodeId: string,
): TrailStep[] {
  const project: TrailStep = {
    key: projectKey,
    label: tree?.title ?? projectKey,
    to: { params: { key: projectKey }, to: '/p/$key' },
  };
  const above = tree === undefined ? [] : (ancestorsOf(tree, nodeId) ?? []);
  return [
    project,
    ...above.map((node) => ({ key: node.id, label: node.title, to: nodeLink(node.id) })),
  ];
}

/**
 * More's entries from its groups, in order, with a separator between two
 * groups and none around an empty one.
 */
export function moreEntries(groups: readonly (readonly ActionMenuAction[])[]): ActionMenuEntry[] {
  const entries: ActionMenuEntry[] = [];
  for (const group of groups.filter((each) => each.length > 0)) {
    if (entries.length > 0) {
      entries.push({ key: `separator-${String(entries.length)}`, kind: 'separator' });
    }
    entries.push(...group);
  }
  return entries;
}

/** A record's More: every action but its main one, as a menu from md and a sheet below it. */
export function RecordMore({
  title,
  recordId,
  entries,
  triggerRef,
}: {
  title: string;
  recordId: string;
  entries: ActionMenuEntry[];
  /** The More button, for a dialog that one of its rows opens to hand focus back to. */
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <ActionMenu
      title={title}
      description={<span className="font-mono">{recordId}</span>}
      entries={entries}
      trigger={
        <ActionButton ref={triggerRef} size="header" variant="pageOutline">
          More
          <ChevronDownIcon className="size-4 text-ink-dim max-md:hidden md:size-4" />
        </ActionButton>
      }
    />
  );
}
