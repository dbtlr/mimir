import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';

/**
 * A card's status line, shared with its preview's header and a record's
 * header: the lead, the record's ID in mono, an optional project name, and
 * the age at the right of the first line. A long project name wraps rather
 * than run past the card. A record header passes `type`, which puts a
 * hairline after the lead and the record's type before its ID ("● Ready |
 * Task MMR-726"; ADR 0019, MMR-726).
 */
export function FeedStatusLine({
  id,
  lead,
  type,
  recordId,
  project,
  age,
  className,
}: {
  /** The element id, so a control can be described by the line. */
  id?: string;
  lead: ReactNode;
  /** The record's type in words ("Task", "Project"), after a hairline. */
  type?: string;
  recordId?: string;
  /**
   * What follows the ID: the project's name where the card's feed spans
   * projects (the Needs you deck), or where a seed was filed from (MMR-725).
   */
  project?: ReactNode;
  age?: string;
  className?: string;
}) {
  return (
    <div id={id} className={cn('flex items-start gap-2 text-meta text-ink-dim', className)}>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 wrap-anywhere">
        {lead}
        {/* Spaces between the parts: flex gaps set them apart on screen, the
            spaces keep them apart in an accessible description. */}{' '}
        {type !== undefined && (
          <>
            <span aria-hidden className="h-3.5 w-px shrink-0 bg-line-bright" />{' '}
            <span className="whitespace-nowrap">{type}</span>{' '}
          </>
        )}
        {recordId !== undefined && <span className="font-mono whitespace-nowrap">{recordId}</span>}{' '}
        {project !== undefined && <span>{project}</span>}
      </span>{' '}
      {age !== undefined && <span className="shrink-0 whitespace-nowrap">{age}</span>}
    </div>
  );
}
