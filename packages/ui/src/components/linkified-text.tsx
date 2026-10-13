import { splitLinks } from '../lib/links';

/** The accent link look, in the surrounding text's own ink (mirrors MarkdownBody's prose-a). */
const LINK_CLASS =
  'underline decoration-accent-foreground/40 underline-offset-2 hover:decoration-accent-foreground';

/**
 * Plain text whose bare http(s) URLs are links that open in a new tab. For a
 * reason shown as its own text node; never inside a BrowserRow, whose stretched
 * link would nest the anchors.
 */
export function LinkifiedText({ children }: { children: string }) {
  return (
    <>
      {splitLinks(children).map((segment, index) =>
        segment.kind === 'url' ? (
          <a
            // Segments are positional and never reorder.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            href={segment.value}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_CLASS}
          >
            {segment.value}
          </a>
        ) : (
          segment.value
        ),
      )}
    </>
  );
}
