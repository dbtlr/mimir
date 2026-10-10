import { fromMarkdown } from 'mdast-util-from-markdown';

/**
 * The seed lede (MMR-263) — a bounded, read-time projection of a seed's
 * `## Seed Description` prose. Nothing is stored: the list path batch-reads the
 * body section for live seeds and derives the lede here, single-sourced so every
 * transport (CLI queue, triage report, HTTP list wire → console preview) shows
 * the same preview (the derive-don't-store spine, ADR 0021). Seed bodies are
 * markdown, so the lede is the body projected to plain prose (MMR-457) — never
 * raw markup — before it is flattened and cut.
 */

/** The lede character budget — the RETURNED lede never exceeds this many
 * characters, trailing ellipsis included (a truncation reserves one character
 * for it). A budget in characters (not lines) keeps the derivation
 * transport-neutral; the console applies its own 2-line CSS clamp on top.
 * Chosen minimal-but-legible: two console lines of body prose. */
export const SEED_LEDE_BUDGET = 240;

/**
 * Derive the bounded lede from a seed's description markdown. The markdown is
 * first projected to plain prose ({@link markdownToPlainText}): no heading,
 * emphasis, list, quote or link markup survives. Whitespace runs (including
 * newlines) then collapse to single spaces so the lede is one clean flowed
 * string; an absent description, or one with no prose (empty, whitespace-only, or
 * only code, block html or rules), yields `null` (no lede). Longer prose is cut at the last
 * word boundary that keeps the result — trailing ellipsis included — within
 * {@link SEED_LEDE_BUDGET}.
 */
export function deriveLede(description: string | null): string | null {
  if (description === null) {
    return null;
  }
  const flattened = markdownToPlainText(description).replace(/\s+/g, ' ').trim();
  if (flattened === '') {
    return null;
  }
  if (flattened.length <= SEED_LEDE_BUDGET) {
    return flattened;
  }
  // Reserve one character for the ellipsis so the returned string stays ≤ budget.
  const slice = flattened.slice(0, SEED_LEDE_BUDGET - 1);
  const lastSpace = slice.lastIndexOf(' ');
  // No space to cut on → hard cut, code-point-safe: a UTF-16 cut landing
  // mid-surrogate-pair would leave a lone high surrogate at the boundary (not a
  // valid string), so back off one unit when the last unit is a high surrogate.
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : trimLoneSurrogate(slice);
  return `${cut.trimEnd()}…`;
}

/** A high surrogate at the end of the string — the head of a pair the cut split. */
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/** Drop a trailing lone high surrogate — the tail of a pair the budget cut split. */
function trimLoneSurrogate(text: string): string {
  return TRAILING_HIGH_SURROGATE.test(text) ? text.slice(0, -1) : text;
}

/** The slice of an mdast node the projection reads; the parser's tree satisfies it. */
type MdNode = {
  readonly type: string;
  readonly value?: string;
  readonly alt?: string | null;
  readonly children?: readonly MdNode[];
};

/** Containers whose children are blocks: their text is joined with a space so
 * words from adjacent blocks never glue together. */
const BLOCK_CONTAINERS: ReadonlySet<string> = new Set([
  'root',
  'blockquote',
  'list',
  'listItem',
  'footnoteDefinition',
]);

/** Nodes that contribute no text: code is dropped whole (see
 * {@link markdownToPlainText}); rules and link definitions carry no prose. (Raw
 * html is context-dependent — see {@link htmlText}.) */
const DROPPED_NODES: ReadonlySet<string> = new Set(['code', 'thematicBreak', 'definition', 'yaml']);

/** A leading GFM task-list marker (`[ ]`, `[x]`, `[X]`) — CommonMark parses it as text. */
const TASK_MARKER = /^\[[ xX]\]\s+/;

/**
 * Project markdown (CommonMark) to plain prose: the text a reader sees, minus the
 * markup. Blocks are separated by a space; emphasis, strong and links give their
 * text, inline code its text without backticks, images their alt text, hard
 * breaks a space, and leading task-list markers are stripped.
 *
 * Fenced and indented code blocks, block-level html, html comments and thematic
 * breaks are DROPPED entirely: a preview should not show code, and dropping it
 * keeps it from eating the budget. Consequently a body that is only a code block
 * has no prose and yields an empty string (so `deriveLede` returns `null`).
 * Inline html keeps its literal text, because CommonMark reads bare placeholders
 * such as `<id>` in prose as inline html.
 */
function markdownToPlainText(markdown: string): string {
  const root = fromMarkdown(markdown);
  return childrenText(root, ' ');
}

/**
 * Raw html: a block-level node (a direct child of a block container) and any
 * comment are dropped; inline html (a child of phrasing content) is literal
 * text — typically a placeholder like `<id>` that the author meant as prose.
 */
function htmlText(node: MdNode, parent: MdNode): string {
  const value = node.value ?? '';
  if (BLOCK_CONTAINERS.has(parent.type) || value.startsWith('<!--')) {
    return '';
  }
  return value;
}

function nodeText(node: MdNode, parent: MdNode): string {
  if (DROPPED_NODES.has(node.type)) {
    return '';
  }
  if (node.type === 'html') {
    return htmlText(node, parent);
  }
  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value ?? '';
  }
  if (node.type === 'image' || node.type === 'imageReference') {
    return node.alt ?? '';
  }
  if (node.type === 'break') {
    return ' ';
  }
  if (node.type === 'listItem') {
    return childrenText(node, ' ').trimStart().replace(TASK_MARKER, '');
  }
  return childrenText(node, BLOCK_CONTAINERS.has(node.type) ? ' ' : '');
}

function childrenText(node: MdNode, separator: string): string {
  return (node.children ?? []).map((child) => nodeText(child, node)).join(separator);
}
