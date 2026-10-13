/** A run of reason text: plain text, or a bare http(s) URL to link. */
export type LinkSegment = { kind: 'text' | 'url'; value: string };

const URL_RUN = /https?:\/\/[^\s<>]+/gi;
const SCHEME = /^https?:\/\//i;
/** Sentence punctuation that ends a URL's run without being part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"\]}]$/;

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/**
 * Trim the sentence punctuation a URL run swallowed. A closing paren stays only
 * while the URL opens one (`/wiki/Foo_(bar)`), so "(see https://x.test)" loses it.
 */
function trimUrlRun(run: string): string {
  let url = run;
  while (url.length > 0) {
    if (
      TRAILING_PUNCTUATION.test(url) ||
      (url.endsWith(')') && count(url, ')') > count(url, '('))
    ) {
      url = url.slice(0, -1);
    } else {
      break;
    }
  }
  return url;
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

/** Whether a link points off the console (an http(s) URL), so it should open in a new tab. */
export function isExternalHref(href: string | undefined): boolean {
  return href !== undefined && SCHEME.test(href);
}
