import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

/*
 * Facts (ADR 0019, MMR-726 and MMR-728 refinements; DESIGN.md, Record
 * header): a record's label and value pairs, in two columns, 104 then the
 * rest, 16 apart and 14 between rows. A record page's Details sections and a
 * state banner on a task's Work hold them.
 */

/** A list of facts: render `Fact`s inside. */
export function Facts({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <dl className={cn('m-0 grid grid-cols-[104px_minmax(0,1fr)] gap-x-4 gap-y-3.5', className)}>
      {children}
    </dl>
  );
}

/** One fact: its label 13 / 20 `ink-dim`, set 1 down to meet the value's first line; the value 14 / 20 `ink-bright`, a long word breaking. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-meta text-ink-dim">{label}</dt>
      <dd className="m-0 min-w-0 text-label wrap-anywhere text-ink-bright">{children}</dd>
    </>
  );
}

/** An identifier in a fact's value (a session, a branch, a host): mono at the sans x-height. */
export function FactMono({ children }: { children: ReactNode }) {
  return <span className="font-mono [font-size-adjust:var(--mono-adjust)]">{children}</span>;
}

/**
 * A fact's value that is a link: one target at least 44 by 44 on a phone and
 * 36 tall from `md`, its whole (wrapped) value, pulled back above and below
 * so the row keeps the list's 14 between rows; `accent-foreground`,
 * underlined on hover.
 */
export const FACT_LINK_CLASS =
  'block w-fit min-w-11 max-w-full -my-3 py-3 text-accent-foreground hover:underline focus-visible:outline-2 focus-visible:outline-accent md:-my-2 md:min-w-0 md:py-2';
