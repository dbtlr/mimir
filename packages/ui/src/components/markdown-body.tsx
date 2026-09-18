import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '../lib/cn';

/**
 * Inline code and code blocks are machine ground: the dark well stays dark in
 * BOTH themes (ADR 0019 §7 rule 4 — the inversion marks the boundary between
 * UI and record), so the values are literal, not theme tokens.
 */
const MACHINE_PROSE = cn(
  'prose-code:rounded-[4px] prose-code:bg-[#0B0F14] prose-code:px-1.5 prose-code:py-px',
  'prose-code:font-mono prose-code:text-xs prose-code:font-normal prose-code:text-[#B9C4CD]',
  'prose-code:before:content-none prose-code:after:content-none',
  'prose-pre:bg-[#0B0F14] prose-pre:text-[#B9C4CD]',
);

/** Route the typography plugin's palette through the Meridian ink tokens. */
const INK_PROSE = cn(
  '[--tw-prose-body:var(--color-ink)] [--tw-prose-invert-body:var(--color-ink)]',
  '[--tw-prose-headings:var(--color-ink-bright)] [--tw-prose-invert-headings:var(--color-ink-bright)]',
  '[--tw-prose-bold:var(--color-ink-bright)] [--tw-prose-invert-bold:var(--color-ink-bright)]',
  '[--tw-prose-links:var(--color-accent-foreground)] [--tw-prose-invert-links:var(--color-accent-foreground)]',
);

/**
 * Bodies are user markdown: an unmapped `#`/`##` would render a literal h1/h2
 * that outranks the host surface's own h2 title in the heading outline. Body
 * headings are demoted to start below it (h1→h3, capped at h6); the prose
 * classes keep the visual size uniform, so only the semantics shift.
 */
const BODY_HEADINGS = { h1: 'h3', h2: 'h4', h3: 'h5', h4: 'h6', h5: 'h6', h6: 'h6' } as const;

/**
 * The console's one markdown renderer — user prose on the Meridian prose
 * scale, with demoted body headings and machine-ground code. Shared by the
 * frozen artifact reader and the direction dialog so a record reads the same
 * wherever it is opened. `className` carries the host's measure (the reader
 * pins 620px), never a new palette.
 */
export function MarkdownBody({ children, className }: { children: string; className?: string }) {
  return (
    <article
      className={cn(
        'prose prose-sm dark:prose-invert text-[0.84375rem] leading-[1.75] max-md:text-sm',
        'prose-headings:text-[0.90625rem] prose-headings:font-semibold',
        // prose-headings covers h1–h4 only; demoted body headings can
        // land on h5/h6, which get the same uniform treatment.
        '[&_:is(h5,h6)]:mt-4 [&_:is(h5,h6)]:text-[0.90625rem] [&_:is(h5,h6)]:font-semibold [&_:is(h5,h6)]:text-ink-bright',
        INK_PROSE,
        MACHINE_PROSE,
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={BODY_HEADINGS}>
        {children}
      </ReactMarkdown>
    </article>
  );
}
