import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';

/**
 * A card's status line, shared with its preview's header: the lead, the
 * record's ID in mono, an optional project name, and the age at the right of
 * the first line. A long project name wraps rather than run past the card.
 */
export function FeedStatusLine({
  id,
  lead,
  recordId,
  project,
  age,
  className,
}: {
  /** The element id, so a control can be described by the line. */
  id?: string;
  lead: ReactNode;
  recordId?: string;
  /** The project's name after the ID, where the card's feed spans projects (the Needs you deck). */
  project?: string;
  age?: string;
  className?: string;
}) {
  return (
    <div id={id} className={cn('flex items-start gap-2 text-meta text-ink-dim', className)}>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 wrap-anywhere">
        {lead}
        {/* Spaces between the parts: flex gaps set them apart on screen, the
            spaces keep them apart in an accessible description. */}{' '}
        {recordId !== undefined && (
          <span className="font-mono whitespace-nowrap">{recordId}</span>
        )}{' '}
        {project !== undefined && <span>{project}</span>}
      </span>{' '}
      {age !== undefined && <span className="shrink-0 whitespace-nowrap">{age}</span>}
    </div>
  );
}
