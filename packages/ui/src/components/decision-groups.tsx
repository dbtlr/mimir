import { Link } from '@tanstack/react-router';

import type { WireReviewReport } from '../api/types';
import { cn } from '../lib/cn';
import type { RowFocusHandoff } from '../lib/use-row-focus-handoff';
import { NeedsYouRow, needsYouActions } from './work-rows';

/** A link to a project or a count in the review page's lists. */
export const PROJECT_LINK =
  'rounded-sm focus-visible:outline-2 focus-visible:outline-accent transition-colors';

/** The project a group of rows belongs to, opening its work page. */
function ProjectHeading({ project }: { project: { key: string; name: string } }) {
  return (
    <h3 className="mb-1">
      <Link
        to="/p/$key"
        params={{ key: project.key }}
        className={cn(PROJECT_LINK, 'inline-flex items-baseline gap-2 hover:text-ink-bright')}
      >
        <span className="font-mono text-mono-id text-accent-foreground">{project.key}</span>
        <span className="text-meta font-semibold text-ink">{project.name}</span>
      </Link>
    </h3>
  );
}

/**
 * The decisions grouped by project, in the review read's order, each row with
 * its in-place verbs (Approve, Send back…, Answer…). Shared by the review
 * page and the top-bar Needs you popover, so a decision reads and acts the
 * same in both. `currentId` marks the decision whose record is on the page.
 */
export function DecisionGroups({
  groups,
  offline,
  handoff,
  currentId,
}: {
  groups: WireReviewReport['decisions'];
  offline: boolean;
  handoff: RowFocusHandoff;
  currentId?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.project.key} aria-label={group.project.name}>
          <ProjectHeading project={group.project} />
          {group.rows.map((row) => (
            <NeedsYouRow
              key={row.id}
              row={row}
              current={row.id === currentId}
              actions={needsYouActions(row, offline, handoff)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
