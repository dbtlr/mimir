import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * One part of a meta line, set off from the text before it by a middle dot
 * (ADR 0019, MMR-718). The line flows as text: a non-breaking space binds the
 * dot to the part before it, so a wrapped line never opens with a dot, and the
 * part is an inline block, so it moves to the next line whole and breaks inside
 * only when it is wider than the line (a hyphen in a branch is no break point).
 * The dot is hidden from assistive tech; the space after it is not, so the
 * parts still read apart.
 */
export function MetaPart({
  children,
  mono = false,
  first = false,
}: {
  children: ReactNode;
  mono?: boolean;
  /** The line's first part: no dot before it. */
  first?: boolean;
}) {
  return (
    <>
      {!first && (
        <>
          <span aria-hidden>{'\u00a0·'}</span>{' '}
        </>
      )}
      <span className={cn('inline-block max-w-full wrap-anywhere', mono && 'font-mono')}>
        {children}
      </span>
    </>
  );
}
