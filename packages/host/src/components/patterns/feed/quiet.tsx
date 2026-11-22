import type { ReactNode } from 'react';

/**
 * A quiet state (ADR 0019, MMR-719 refinement): a plain sentence in body ink
 * with no frame, since it offers nothing to tap. As a quiet line it stands in
 * for one empty section ("Nothing needs you."); as a quiet sentence it says
 * once what the rest of a page's empty sections would have said.
 */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className="mt-8 mb-0 max-w-prose px-1 text-body text-ink first:mt-0">{children}</p>;
}
