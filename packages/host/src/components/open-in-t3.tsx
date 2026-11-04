import { useQuery } from '@tanstack/react-query';

import { t3OriginQuery } from '../api/t3-queries';
import { cn } from '../lib/cn';
import { t3ThreadLink } from '../lib/t3-link';
import type { T3ThreadHandles } from '../lib/t3-link';

/**
 * The Open in T3 link (ADR 0040): T3's app link to the task's thread, which
 * hands off to the T3 app, so it opens in place rather than in a new tab.
 * Nothing renders without an origin or when the handles make no safe link. It
 * sits above a row's stretched link so a tap reaches it on a phone.
 */
export function OpenInT3({ className, ...handles }: T3ThreadHandles & { className?: string }) {
  const origin = useQuery(t3OriginQuery).data?.origin ?? null;
  const link = t3ThreadLink(origin, handles);
  if (link === null) {
    return null;
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
