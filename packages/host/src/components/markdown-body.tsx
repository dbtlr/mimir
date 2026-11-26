import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { cn } from '../lib/cn';
import { isExternalHref } from '../lib/links';

/**
 * Two code treatments, one rule (ADR 0019 §7 rule 4 and its MMR-445
 * refinement). Fenced blocks are machine ground: the dark well stays dark in
 * BOTH themes (the inversion marks the boundary between UI and record), so
 * their values are literal, not theme tokens. Inline code is not a readout: it
 * is coloured monospace text in the dedicated `--color-code` token, so it
 * reads apart from links (accent) and from blocks.
 *
 * Inline code — no pill, no padding, no injected backticks. Its own group so
 * the treatment can be swapped without touching the blocks.
 */
const INLINE_CODE_PROSE = cn(
  'prose-code:font-mono prose-code:text-[max(12px,0.9em)] prose-code:font-normal prose-code:text-code',
  'prose-code:before:content-none prose-code:after:content-none',
  '[--tw-prose-code:var(--color-code)] [--tw-prose-invert-code:var(--color-code)]',
);

/** Fenced code blocks — the same well; they scroll sideways rather than widen the host. */
const CODE_BLOCK_PROSE = cn(
  // The hairline keeps the well legible against the dark page.
  'prose-pre:overflow-x-auto prose-pre:border prose-pre:border-line-bright prose-pre:bg-[#0B0F14] prose-pre:text-[#B9C4CD]',
  // Inside a block the code sits on the pre's own ground.
  // The block's code keeps the machine ink, never the inline colour.
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[#B9C4CD] [&_pre_code]:text-xs',
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
  '[--tw-prose-bullets:var(--color-ink-dim)] [--tw-prose-invert-bullets:var(--color-ink-dim)]',
  '[--tw-prose-hr:var(--color-line-bright)] [--tw-prose-invert-hr:var(--color-line-bright)]',
  '[--tw-prose-quotes:var(--color-ink-dim)] [--tw-prose-invert-quotes:var(--color-ink-dim)]',
  '[--tw-prose-quote-borders:var(--color-ink-faint)] [--tw-prose-invert-quote-borders:var(--color-ink-faint)]',
  '[--tw-prose-captions:var(--color-ink-dim)] [--tw-prose-invert-captions:var(--color-ink-dim)]',
  '[--tw-prose-kbd:var(--color-ink-bright)] [--tw-prose-invert-kbd:var(--color-ink-bright)]',
  '[--tw-prose-th-borders:var(--color-line-bright)] [--tw-prose-invert-th-borders:var(--color-line-bright)]',
  '[--tw-prose-td-borders:var(--color-line)] [--tw-prose-invert-td-borders:var(--color-line)]',
);

/**
 * Body headings sit in a modest ladder below the host's own title, sized in
 * `em` so they follow the text scale: h3 1.2em bold → h4 1.1em → h5 body size
 * → h6 a small dim label. Even the largest (~16px at the default scale) stays
 * under the 17px record title. Margins are em too, so a heading's spacing
 * tracks its size.
 */
const HEADING_PROSE = cn(
  '[&_:is(h3,h4,h5,h6)]:leading-snug [&_:is(h3,h4,h5,h6)]:mt-[1.5em] [&_:is(h3,h4,h5,h6)]:mb-[0.5em]',
  '[&_h3]:text-[1.2em] [&_h3]:font-bold [&_h3]:tracking-tight',
  '[&_h4]:text-[1.1em] [&_h4]:font-semibold',
  '[&_h5]:text-[1em] [&_h5]:font-semibold [&_h5]:text-ink-bright',
  '[&_h6]:text-[max(12px,0.8em)] [&_h6]:font-semibold [&_h6]:tracking-[0.1em] [&_h6]:text-ink-dim [&_h6]:uppercase',
  // A body that opens with a heading starts flush; the last block adds no tail.
  '[&>:first-child]:mt-0 [&>:last-child]:mb-0',
);

/**
 * GFM task-list boxes are read-only, and a browser greys a native disabled
 * checkbox past what `accent-color` or `opacity` can undo, so they are drawn
 * here: a hollow ink-dim box, filled with the action token (and its tick) when
 * checked. The tick is an inline SVG, so its colour is a literal pair — dark
 * ink on the dark theme's teal, white on the light theme's slate.
 */
const TASK_BOX_PROSE = cn(
  '[&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:size-[1.05em] [&_input[type=checkbox]]:appearance-none',
  '[&_input[type=checkbox]]:rounded-[3px] [&_input[type=checkbox]]:border [&_input[type=checkbox]]:border-ink-dim',
  '[&_input[type=checkbox]]:bg-transparent [&_input[type=checkbox]]:bg-center [&_input[type=checkbox]]:bg-no-repeat',
  '[&_input[type=checkbox]]:align-[-0.2em]',
  '[&_input[type=checkbox]:checked]:border-action [&_input[type=checkbox]:checked]:bg-action',
  '[&_input[type=checkbox]:checked]:bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2016%2016%27%3E%3Cpath%20d=%27M3.5%208.5l3%203%206-6.5%27%20fill=%27none%27%20stroke=%27%2308222a%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27/%3E%3C/svg%3E)]',
  // Windows high-contrast mode drops author colours; hand the box back to the native control.
  'forced-colors:[&_input[type=checkbox]]:appearance-auto',
  'light:[&_input[type=checkbox]:checked]:bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2016%2016%27%3E%3Cpath%20d=%27M3.5%208.5l3%203%206-6.5%27%20fill=%27none%27%20stroke=%27%23ffffff%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27/%3E%3C/svg%3E)]',
);

/** Everything between the headings and the code: flow, lists, quotes, rules, tables, media. */
const BLOCK_PROSE = cn(
  'break-words',
  'prose-p:my-3 prose-em:italic',
  'prose-a:underline prose-a:decoration-accent-foreground/40 prose-a:underline-offset-2',
  'prose-a:hover:decoration-accent-foreground',
  'prose-ul:my-3 prose-ol:my-3 prose-li:my-1 [&_li>ul]:my-1 [&_li>ol]:my-1',
  // GFM task lists: no bullet, nested ones keep their indent, the box tracks the text.
  '[&_.contains-task-list]:list-none [&_.contains-task-list]:pl-0',
  '[&_.contains-task-list_.contains-task-list]:pl-5',
  TASK_BOX_PROSE,
  // The plugin italicises quotes and injects curly quote marks; neither belongs here.
  'prose-blockquote:border-l-2 prose-blockquote:font-normal prose-blockquote:not-italic',
  '[&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none',
  'prose-hr:my-6',
  'prose-th:font-semibold prose-th:text-ink-bright',
  // The table fills the measure; the wrapper from BODY_COMPONENTS scrolls it.
  // prose-sm sets tables and kbd at 0.857em: a table takes the 13px meta size, and kbd keeps the 12px floor (MMR-718).
  'prose-table:my-0 prose-table:w-full prose-table:text-meta',
  // A footnote marker and a caption carry information too, so they keep the floor.
  '[&_sup]:text-[max(12px,0.75em)] prose-figcaption:text-[max(12px,0.857em)]',
  'prose-img:h-auto prose-img:max-w-full prose-img:rounded',
  'prose-kbd:text-[max(12px,0.857em)] prose-kbd:rounded prose-kbd:border prose-kbd:border-line-bright prose-kbd:shadow-none',
);

/**
 * Bodies are user markdown: an unmapped `#`/`##` would render a literal h1/h2
 * that outranks the host surface's own h2 title in the heading outline. Body
 * headings are demoted to start below it (h1→h3, capped at h6), and
 * HEADING_PROSE sizes the demoted levels as a modest ladder.
 */
const BODY_HEADINGS = { h1: 'h3', h2: 'h4', h3: 'h5', h4: 'h6', h5: 'h6', h6: 'h6' } as const;

/** A wide table scrolls inside its wrapper while the table itself fills the measure. */
function ScrollingTable({ node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  return (
    <div data-md="table" className="my-3 overflow-x-auto">
      <table {...props} />
    </div>
  );
}

/**
 * An image as a link to it: opening a record never fetches a remote URL, which
 * would hand the viewer's IP and read time to whoever wrote the image in.
 */
function ImageLink({ src, alt, tabIndex }: ComponentProps<'img'>) {
  const href = typeof src === 'string' ? src : undefined;
  const external = isExternalHref(href);
  return (
    <a
      href={href}
      tabIndex={tabIndex}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
    >
      Image: {alt || 'untitled'}
    </a>
  );
}

/**
 * A link: an external http(s) one opens in a new tab so reading a record never
 * navigates away from the console; relative, anchor, and other-scheme links keep
 * the browser's default.
 */
function MarkdownLink({
  node: _node,
  children,
  ...props
}: ComponentProps<'a'> & { node?: unknown }) {
  const external = isExternalHref(props.href);
  return (
    <a
      {...props}
      target={external ? '_blank' : props.target}
      rel={external ? 'noopener noreferrer' : props.rel}
    >
      {children}
    </a>
  );
}

const BODY_COMPONENTS = {
  ...BODY_HEADINGS,
  a: MarkdownLink,
  img: ImageLink,
  table: ScrollingTable,
};
const DOCUMENT_COMPONENTS = { ...BODY_HEADINGS, a: MarkdownLink, table: ScrollingTable };

/**
 * The 3-line preview has no expander, so a link it clips would still take
 * focus and scroll it; its links stay out of the tab order, and the whole
 * text lives where the preview points (a task's Timeline).
 */
const PREVIEW_COMPONENTS = {
  ...BODY_COMPONENTS,
  a: (props: ComponentProps<typeof MarkdownLink>) => <MarkdownLink {...props} tabIndex={-1} />,
  img: (props: ComponentProps<'img'>) => <ImageLink {...props} tabIndex={-1} />,
};

/**
 * The text scales a host can ask for. `default` is the reading scale;
 * `body` is `text-body`, 14 / 23 at every width, for the task page's prose
 * (its description, a state banner's, a timeline note's).
 */
export type MarkdownSize = 'default' | 'body';

const SIZE_PROSE: Record<MarkdownSize, string> = {
  body: 'text-body leading-[23px]',
  default: 'text-[0.84375rem] leading-[1.75] max-md:text-sm',
};

/**
 * Height clamps in line units: `lh` resolves against the article's own
 * line-height, and block children (code, tables) clamp too, which
 * `-webkit-line-clamp` cannot do. Where layout reports line boxes, the clamp
 * moves to the bottom of its last whole line (`--clamp-height`), so block
 * margins never leave a line cut in half (MMR-728), and a text with no more
 * lines than the clamp shows whole. The 12-line fold fades
 * that last line only, and only once the content really overflows, so a
 * short body is never dimmed; the 3-line preview ends on whole lines with no
 * fade.
 */
const CLAMP_FADE =
  'data-[overflowing]:[mask-image:linear-gradient(to_bottom,black_calc(100%_-_1lh),transparent)]';
const CLAMP_PROSE: Record<MarkdownClamp, string> = {
  12: cn('max-h-[var(--clamp-height,12lh)] overflow-hidden', CLAMP_FADE),
  3: 'max-h-[var(--clamp-height,3lh)] overflow-hidden',
};

/** What a clamped body measured: whether it overflows, and its rendered line count. */
export type ClampMeasure = { overflowing: boolean; lines: number };

export type MarkdownClamp = 3 | 12;

/**
 * The measured clamp as the `--clamp-height` the clamp class reads: a height,
 * or `none` for a text that fits; undefined leaves its `lh` fallback.
 */
function clampStyle(height: number | 'none' | undefined): CSSProperties | undefined {
  if (height === undefined) {
    return undefined;
  }
  const style: CSSProperties & Record<'--clamp-height', string> = {
    '--clamp-height': height === 'none' ? 'none' : `${String(height)}px`,
  };
  return style;
}

/**
 * The distance from `el`'s top to the bottom of each rendered line of its
 * text, in order, read from the text's boxes and `lineHeight`; undefined where
 * layout reports none (jsdom).
 */
function lineBottoms(el: HTMLElement, lineHeight: number): number[] | undefined {
  const range = el.ownerDocument.createRange();
  // jsdom lays nothing out, and its ranges have no client rects to read.
  if (typeof range.getClientRects !== 'function') {
    return undefined;
  }
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const boxes: { top: number; bottom: number }[] = [];
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
    // The whitespace between blocks lays out as no line, but still reports a box.
    if (text.textContent?.trim() === '') {
      continue;
    }
    range.selectNodeContents(text);
    for (const rect of range.getClientRects()) {
      if (rect.height > 0 && rect.width > 0) {
        // A text box is its glyphs' height; the line box adds half the leading below.
        boxes.push({
          bottom: rect.bottom + Math.max(0, lineHeight - rect.height) / 2,
          top: rect.top,
        });
      }
    }
  }
  boxes.sort((a, b) => a.top - b.top);
  // A box that starts above the current line's bottom shares its line (a code span, a link).
  const bottoms: number[] = [];
  let lineBottom: number | undefined;
  for (const box of boxes) {
    if (lineBottom !== undefined && box.top < lineBottom - 1) {
      lineBottom = Math.max(lineBottom, box.bottom);
      bottoms[bottoms.length - 1] = lineBottom;
    } else {
      lineBottom = box.bottom;
      bottoms.push(lineBottom);
    }
  }
  const top = el.getBoundingClientRect().top;
  return bottoms.map((bottom) => bottom - top);
}

/**
 * The console's one markdown renderer — user prose on the Meridian prose
 * scale, with a heading ladder under the host's title, every element on Meridian
 * tokens, and machine-ground code. Shared by every
 * surface that shows authored text (the artifact reader, the direction dialog,
 * node descriptions, notes, and seed bodies) so a record reads the same
 * wherever it is opened. `className` carries the host's measure (the reader
 * pins 620px), never a new palette; `size` picks the text scale.
 *
 * `clamp` limits the rendered height to that many whole lines (the 12-line
 * fold fading its last line when the content overflows), and reports the measure through
 * `onClampMeasure` (stable callback expected) so the host can offer an expander.
 * Omit `clamp` to show the whole body. `data-clamped` marks the clamped state
 * with its line count. The 3-line preview keeps its links out of the tab order.
 *
 * `breaks` keeps single newlines as line breaks. Comment-like fields
 * (descriptions, notes, seed bodies) pass it so authored line breaks survive,
 * the way GitHub renders comments; documents (artifacts, direction) leave it
 * off and follow standard markdown, where a single newline joins the line.
 *
 * `images` loads markdown images. Without it an image renders as a link to its
 * URL, so a body written by an agent cannot make the console fetch a remote
 * address; only the artifact page's reader opts in.
 */
export function MarkdownBody({
  children,
  className,
  size = 'default',
  breaks = false,
  images = false,
  clamp,
  onClampMeasure,
}: {
  children: string;
  className?: string;
  size?: MarkdownSize;
  breaks?: boolean;
  images?: boolean;
  clamp?: MarkdownClamp;
  onClampMeasure?: (measure: ClampMeasure) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const bodyComponents = clamp === 3 ? PREVIEW_COMPONENTS : BODY_COMPONENTS;
  const [overflowing, setOverflowing] = useState(false);
  const [clampHeight, setClampHeight] = useState<number | 'none' | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (clamp === undefined || el === null) {
      return undefined;
    }
    const measure = (): void => {
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      const bottoms = lineBottoms(el, lineHeight);
      // Where layout reports lines, only more lines than the clamp fold, so
      // block margins alone never do. Otherwise, measured while clamped:
      // scrollHeight is the full content, clientHeight the clamp.
      const over =
        bottoms === undefined ? el.scrollHeight > el.clientHeight + 1 : bottoms.length > clamp;
      setOverflowing(over);
      if (bottoms === undefined) {
        setClampHeight(undefined);
      } else {
        setClampHeight(over ? bottoms[clamp - 1] : 'none');
      }
      // Text lines where layout reports them, so block margins count as none.
      const estimate = lineHeight > 0 ? Math.ceil(el.scrollHeight / lineHeight) : 0;
      onClampMeasure?.({ lines: bottoms?.length ?? estimate, overflowing: over });
    };
    measure();
    // A width change rewraps the text, so the overflow verdict can flip on resize.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
    // The effect measures the DOM `children` renders, so a new text must re-measure.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [children, clamp, onClampMeasure]);
  return (
    <article
      ref={ref}
      data-clamped={clamp}
      data-overflowing={clamp !== undefined && overflowing ? 'true' : undefined}
      className={cn(
        'prose prose-sm dark:prose-invert',
        HEADING_PROSE,
        BLOCK_PROSE,
        SIZE_PROSE[size],
        INK_PROSE,
        INLINE_CODE_PROSE,
        CODE_BLOCK_PROSE,
        clamp !== undefined && CLAMP_PROSE[clamp],
        className,
      )}
      style={clamp === undefined ? undefined : clampStyle(clampHeight)}
    >
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        components={images ? DOCUMENT_COMPONENTS : bodyComponents}
      >
        {children}
      </ReactMarkdown>
    </article>
  );
}
