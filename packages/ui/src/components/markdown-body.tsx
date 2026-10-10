import type { Ref } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '../lib/cn';

/**
 * Machine ground: the dark well stays dark in BOTH themes (ADR 0019 §7 rule 4
 * — the inversion marks the boundary between UI and record), so the values in
 * the two groups below are literal, not theme tokens.
 *
 * Inline code — the single-backtick pill. Its own group so the treatment can
 * be swapped without touching the blocks.
 */
const INLINE_CODE_PROSE = cn(
  'prose-code:rounded-[4px] prose-code:bg-[#0B0F14] prose-code:px-1.5 prose-code:py-px',
  'prose-code:font-mono prose-code:text-xs prose-code:font-normal prose-code:text-[#B9C4CD]',
  'prose-code:before:content-none prose-code:after:content-none',
  '[--tw-prose-code:#B9C4CD] [--tw-prose-invert-code:#B9C4CD]',
);

/** Fenced code blocks — the same well; they scroll sideways rather than widen the host. */
const CODE_BLOCK_PROSE = cn(
  'prose-pre:overflow-x-auto prose-pre:bg-[#0B0F14] prose-pre:text-[#B9C4CD]',
  // Inside a block the code sits on the pre's own ground, not a second pill.
  '[&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[--tw-prose-pre-code:#B9C4CD] [--tw-prose-invert-pre-code:#B9C4CD]',
  '[--tw-prose-pre-bg:#0B0F14] [--tw-prose-invert-pre-bg:#0B0F14]',
);

/**
 * Route every variable of the typography plugin's palette through the Meridian
 * tokens, in both its light and `invert` halves, so no element renders in the
 * plugin's default grays. (`kbd-shadows` is an RGB triplet the tokens cannot
 * fill; kbd drops that shadow for a token border instead — see BLOCK_PROSE.)
 */
const INK_PROSE = cn(
  '[--tw-prose-body:var(--color-ink)] [--tw-prose-invert-body:var(--color-ink)]',
  '[--tw-prose-headings:var(--color-ink-bright)] [--tw-prose-invert-headings:var(--color-ink-bright)]',
  '[--tw-prose-lead:var(--color-ink-dim)] [--tw-prose-invert-lead:var(--color-ink-dim)]',
  '[--tw-prose-bold:var(--color-ink-bright)] [--tw-prose-invert-bold:var(--color-ink-bright)]',
  '[--tw-prose-links:var(--color-accent-foreground)] [--tw-prose-invert-links:var(--color-accent-foreground)]',
  '[--tw-prose-counters:var(--color-ink-dim)] [--tw-prose-invert-counters:var(--color-ink-dim)]',
  '[--tw-prose-bullets:var(--color-ink-faint)] [--tw-prose-invert-bullets:var(--color-ink-faint)]',
  '[--tw-prose-hr:var(--color-line-bright)] [--tw-prose-invert-hr:var(--color-line-bright)]',
  '[--tw-prose-quotes:var(--color-ink-dim)] [--tw-prose-invert-quotes:var(--color-ink-dim)]',
  '[--tw-prose-quote-borders:var(--color-line-bright)] [--tw-prose-invert-quote-borders:var(--color-line-bright)]',
  '[--tw-prose-captions:var(--color-ink-faint)] [--tw-prose-invert-captions:var(--color-ink-faint)]',
  '[--tw-prose-kbd:var(--color-ink-bright)] [--tw-prose-invert-kbd:var(--color-ink-bright)]',
  '[--tw-prose-th-borders:var(--color-line-bright)] [--tw-prose-invert-th-borders:var(--color-line-bright)]',
  '[--tw-prose-td-borders:var(--color-line)] [--tw-prose-invert-td-borders:var(--color-line)]',
);

/**
 * Body headings sit in a modest ladder below the host's own title, sized in
 * `em` so they follow the text scale: h3 1.2em bold → h4 1.1em → h5 body size
 * → h6 a small dim label. Even the largest (~16px at the default scale) stays
 * under the 17px dossier title. Margins are em too, so a heading's spacing
 * tracks its size.
 */
const HEADING_PROSE = cn(
  '[&_:is(h3,h4,h5,h6)]:leading-snug [&_:is(h3,h4,h5,h6)]:mt-[1.5em] [&_:is(h3,h4,h5,h6)]:mb-[0.5em]',
  '[&_h3]:text-[1.2em] [&_h3]:font-bold [&_h3]:tracking-tight',
  '[&_h4]:text-[1.1em] [&_h4]:font-semibold',
  '[&_h5]:text-[1em] [&_h5]:font-semibold',
  '[&_h6]:text-[0.8em] [&_h6]:font-semibold [&_h6]:tracking-wider [&_h6]:text-ink-dim [&_h6]:uppercase',
  // A body that opens with a heading starts flush; the last block adds no tail.
  '[&>:first-child]:mt-0 [&>:last-child]:mb-0',
);

/** Everything between the headings and the code: flow, lists, quotes, rules, tables, media. */
const BLOCK_PROSE = cn(
  'break-words',
  'prose-p:my-3 prose-em:italic',
  'prose-a:underline prose-a:decoration-accent-foreground/40 prose-a:underline-offset-2',
  'hover:prose-a:decoration-accent-foreground',
  'prose-ul:my-3 prose-ol:my-3 prose-li:my-1 [&_li>ul]:my-1 [&_li>ol]:my-1',
  // GFM task lists: no bullet, nested ones keep their indent, the box tracks the text.
  '[&_.contains-task-list]:list-none [&_.contains-task-list]:pl-0',
  '[&_.contains-task-list_.contains-task-list]:pl-5',
  '[&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:align-middle [&_input[type=checkbox]]:accent-accent',
  // The plugin italicises quotes and injects curly quote marks; neither belongs here.
  'prose-blockquote:border-l-2 prose-blockquote:font-normal prose-blockquote:not-italic',
  '[&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none',
  'prose-hr:my-6',
  'prose-th:font-semibold prose-th:text-ink-bright',
  '[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto',
  'prose-img:h-auto prose-img:max-w-full prose-img:rounded',
  'prose-kbd:rounded prose-kbd:border prose-kbd:border-line-bright prose-kbd:shadow-none',
);

/**
 * Bodies are user markdown: an unmapped `#`/`##` would render a literal h1/h2
 * that outranks the host surface's own h2 title in the heading outline. Body
 * headings are demoted to start below it (h1→h3, capped at h6), and
 * HEADING_PROSE sizes the demoted levels as a modest ladder.
 */
const BODY_HEADINGS = { h1: 'h3', h2: 'h4', h3: 'h5', h4: 'h6', h5: 'h6', h6: 'h6' } as const;

/**
 * The two text scales a host can ask for. `default` is the reading scale;
 * `compact` is the secondary-text scale (`text-meta`) for dense surfaces — a
 * timeline note, the quick view — with the block margins tightened to match.
 */
export type MarkdownSize = 'default' | 'compact';

const SIZE_PROSE: Record<MarkdownSize, string> = {
  compact:
    'text-meta leading-[1.6] prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-pre:my-1.5',
  default: 'text-[0.84375rem] leading-[1.75] max-md:text-sm',
};

/**
 * The console's one markdown renderer — user prose on the Meridian prose
 * scale, with a heading ladder under the host's title, every element on Meridian
 * tokens, and machine-ground code. Shared by every
 * surface that shows authored text (the artifact reader, the direction dialog,
 * node descriptions, notes, and seed bodies) so a record reads the same
 * wherever it is opened. `className` carries the host's measure (the reader
 * pins 620px) or clamp, never a new palette; `size` picks the text scale; `ref`
 * lets a clamping host measure the rendered block.
 */
export function MarkdownBody({
  children,
  className,
  size = 'default',
  ref,
}: {
  children: string;
  className?: string;
  size?: MarkdownSize;
  ref?: Ref<HTMLElement>;
}) {
  return (
    <article
      ref={ref}
      className={cn(
        'prose prose-sm dark:prose-invert',
        HEADING_PROSE,
        BLOCK_PROSE,
        // After BLOCK_PROSE so the compact margins win the merge.
        SIZE_PROSE[size],
        INK_PROSE,
        INLINE_CODE_PROSE,
        CODE_BLOCK_PROSE,
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={BODY_HEADINGS}>
        {children}
      </ReactMarkdown>
    </article>
  );
}
