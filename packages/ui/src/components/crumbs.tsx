import { Link } from '@tanstack/react-router';

import type { WireTreeNode } from '../api/types';
import { ancestorsOf } from '../lib/ancestry';
import { nodeLink } from '../lib/record-url';

/**
 * The path above a record: its project, then each container down to its parent.
 * Record and work pages retired it for the sidebar outline (MMR-496); the focus
 * queue keeps it, because its cards come from any project and the sidebar shows
 * only the current one.
 */
export function Crumbs({
  projectKey,
  tree,
  nodeId,
}: {
  projectKey: string;
  tree?: WireTreeNode;
  nodeId: string;
}) {
  const ancestors = tree === undefined ? [] : (ancestorsOf(tree, nodeId) ?? []);
  const crumb =
    'rounded-sm font-mono text-tag text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <nav aria-label="Path" className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <Link to="/p/$key" params={{ key: projectKey }} className={crumb}>
        {tree?.title ?? projectKey}
      </Link>
      {ancestors.map((a) => (
        <span key={a.id} className="flex items-baseline gap-1.5">
          <span aria-hidden className="text-tag text-ink-faint">
            ›
          </span>
          <Link {...nodeLink(a.id)} className={crumb}>
            {a.title}
          </Link>
        </span>
      ))}
    </nav>
  );
}
