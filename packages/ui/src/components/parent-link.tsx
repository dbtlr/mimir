import { Link } from '@tanstack/react-router';

import type { WireTreeNode } from '../api/types';
import { ancestorsOf } from '../lib/ancestry';
import { nodeLink } from '../lib/record-url';

function ParentLabel({ title }: { title: string }) {
  return (
    <>
      <span aria-hidden>↑</span>
      <span className="truncate">{title}</span>
    </>
  );
}

/**
 * The one link above a record's id on a phone (MMR-496): its nearest container,
 * or the project when no container holds it. A desktop reads the same place off
 * the sidebar outline, so the link hides from `lg` up (below it the sidebar is a drawer).
 */
export function ParentLink({
  projectKey,
  tree,
  nodeId,
}: {
  projectKey: string;
  tree?: WireTreeNode;
  nodeId: string;
}) {
  const parent = tree === undefined ? undefined : ancestorsOf(tree, nodeId)?.at(-1);
  const className =
    'flex min-w-0 items-baseline gap-1.5 rounded-sm text-meta text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent lg:hidden';
  return parent === undefined ? (
    <Link to="/p/$key" params={{ key: projectKey }} className={className}>
      <ParentLabel title={tree?.title ?? projectKey} />
    </Link>
  ) : (
    <Link {...nodeLink(parent.id)} className={className}>
      <ParentLabel title={parent.title} />
    </Link>
  );
}
