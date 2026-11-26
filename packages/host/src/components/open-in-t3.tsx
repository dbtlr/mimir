import { useQuery } from '@tanstack/react-query';

import { t3OriginQuery } from '../api/t3-queries';
import { cn } from '../lib/cn';
import { t3ThreadLink } from '../lib/t3-link';
import type { T3ThreadHandles } from '../lib/t3-link';
import { actionButtonVariants } from './ui/action-button';
import { ExternalIcon } from './ui/icons';

/**
 * Where Open in T3 sits, which sets its look: a text link in a row, or an
 * outline button, its edge `ink-faint` on a card and `ink-dim` on the page
 * (DESIGN.md, Control edges).
 */
export type OpenInT3Look = 'link' | 'card' | 'page';

/**
 * The Open in T3 link (ADR 0040): T3's app link to the task's thread, which
 * hands off to the T3 app, so it opens in place rather than in a new tab.
 * Nothing renders without an origin or when the handles make no safe link. As
 * a link it sits above a row's stretched link so a tap reaches it on a phone;
 * as a button (a task's Agent at work banner and Details › Run, MMR-728) it is
 * the record header's height, with the external arrow after its words.
 */
export function OpenInT3({
  className,
  look = 'link',
  ...handles
}: T3ThreadHandles & { className?: string; look?: OpenInT3Look }) {
  const origin = useQuery(t3OriginQuery).data?.origin ?? null;
  const link = t3ThreadLink(origin, handles);
  if (link === null) {
    return null;
  }
  if (look !== 'link') {
    return (
      <a
        href={link}
        className={cn(
          actionButtonVariants({
            size: 'header',
            variant: look === 'card' ? 'formOutline' : 'pageOutline',
          }),
          'self-start',
          className,
        )}
      >
        Open in T3
        <ExternalIcon className="size-4 text-ink-dim md:size-4" />
      </a>
    );
  }
  return (
    <a
      href={link}
      className={cn(
        'relative z-10 inline-flex items-center py-1 text-xs text-accent-foreground hover:underline',
        className,
      )}
    >
      Open in T3 ↗
    </a>
  );
}
