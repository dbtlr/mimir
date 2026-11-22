import type { ReactNode } from 'react';

/** One labelled block of the dev-only `/kit` showcase. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="microlabel text-ink-dim">{title}</h2>
      {children}
    </section>
  );
}

/** A labelled sample inside a Section: one state or variant of a primitive. */
export function Sample({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-well-850 p-4">
      <span className="text-mono-id font-mono text-ink-dim">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
