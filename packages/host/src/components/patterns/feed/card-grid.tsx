import type { ReactNode } from 'react';

/** Feed cards in a stack 8px apart on a phone, two columns 12px apart from `md` up. */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 md:grid-cols-2 md:gap-3">{children}</div>;
}
