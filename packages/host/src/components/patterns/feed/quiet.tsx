import type { ReactNode, Ref } from 'react';

/**
 * A quiet state (ADR 0019, MMR-719 refinement): a plain sentence in body ink
 * with no frame, since it offers nothing to tap. As a quiet line it stands in
 * for one empty section ("Nothing needs you."); as a quiet sentence it says
 * once what the rest of a page's empty sections would have said. A `ref`
 * makes it focusable from script, for a section whose last card left while
 * it held focus (MMR-721).
 */
export function Quiet({ children, ref }: { children: ReactNode; ref?: Ref<HTMLParagraphElement> }) {
  return (
    <p
      ref={ref}
      tabIndex={ref === undefined ? undefined : -1}
      className="mt-8 mb-0 max-w-prose text-body text-ink first:mt-0"
    >
      {children}
    </p>
  );
}
