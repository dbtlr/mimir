/** A run of reason text: plain text, or a bare http(s) URL to link. */
export type LinkSegment = { kind: 'text' | 'url'; value: string };

/** A bare URL ends at whitespace, an angle bracket, or an invisible zero-width character. */
const URL_RUN = /https?:\/\/[^\s<>\u200B-\u200D\u2060\uFEFF]+/gi;
const SCHEME = /^https?:\/\//i;
/** An http(s) or protocol-relative (`//host`) reference: it leaves the console. */
const EXTERNAL_HREF = /^(?:https?:)?\/\//i;
/**
 * Characters that end a URL's run without being part of it: sentence punctuation,
 * markdown emphasis and code delimiters, quotes, and CJK full-width punctuation.
 * Closing brackets are handled separately because a URL can legitimately hold them.
 */
const TRAILING_PUNCTUATION = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  "'",
  '"',
  '}',
  '`',
  '*',
  '_',
  '>',
  '\u3002', // 。
  '\uFF0C', // ，
  '\u3001', // 、
  '\uFF1B', // ；
  '\uFF1A', // ：
  '\uFF01', // ！
  '\uFF1F', // ？
]);

/** Closing bracket -> the opening bracket that justifies keeping it. */
const BRACKET_PAIRS: Record<string, string> = { ')': '(', ']': '[' };

/** How many times `char` occurs in `text`. */
function count(text: string, char: string): number {
  let total = 0;
  for (const c of text) {
    if (c === char) {
      total += 1;
    }
  }
  return total;
}

/**
 * Trim the trailing characters a URL run swallowed. A closing `)` or `]` stays only
 * while the URL opens one (`/wiki/Foo_(bar)`, `http://[::1]`), so "(see https://x.test)"
 * loses it. Brackets are counted once and adjusted as they are trimmed, so a long
 * run of closers costs linear time.
 */
function trimUrlRun(run: string): string {
  const unmatched: Record<string, number> = {};
  for (const [close, open] of Object.entries(BRACKET_PAIRS)) {
    unmatched[close] = count(run, close) - count(run, open);
  }
  let end = run.length;
  while (end > 0) {
    const char = run[end - 1] ?? '';
    if (TRAILING_PUNCTUATION.has(char)) {
      end -= 1;
    } else if ((unmatched[char] ?? 0) > 0) {
      unmatched[char] = (unmatched[char] ?? 0) - 1;
      end -= 1;
    } else {
      break;
    }
  }
  return run.slice(0, end);
}

/**
 * Split text into plain and bare-URL segments so a reason can render its URLs
 * as links. Concatenating the segment values gives back the input exactly.
 */
export function splitLinks(text: string): LinkSegment[] {
  const segments: LinkSegment[] = [];
  let cursor = 0;
  const push = (kind: LinkSegment['kind'], value: string): void => {
    if (value === '') {
      return;
    }
    const last = segments.at(-1);
    if (kind === 'text' && last?.kind === 'text') {
      last.value += value;
    } else {
      segments.push({ kind, value });
    }
  };
  for (const match of text.matchAll(URL_RUN)) {
    const url = trimUrlRun(match[0]);
    // "https://" followed only by punctuation is not a link.
    if (url.replace(SCHEME, '') === '') {
      continue;
    }
    push('text', text.slice(cursor, match.index));
    push('url', url);
    cursor = match.index + url.length;
  }
  push('text', text.slice(cursor));
  return segments;
}

/** Whether a link points off the console (an http(s) or `//host` URL), so it should open in a new tab. */
export function isExternalHref(href: string | undefined): boolean {
  return href !== undefined && EXTERNAL_HREF.test(href);
}
