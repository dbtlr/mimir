import type { ComponentProps } from 'react';

import { cn } from '../../../lib/cn';
import { FEED_FOCUS_RING, FEED_LINK_TEXT } from './link';

/**
 * A feed's one text button for more of a list: "Show 3 more" under a day's
 * rows, "Show 50 more" closing a list that loads by window. 14 / 20, 500,
 * `accent-foreground`, underlined on hover, 44 tall on a phone and 36 from
 * `md` up, pulled 4 left so its text lines up with the rows. While `loading`
 * it stays focusable and says it is busy (`aria-disabled`), so a press during
 * the load neither repeats it nor drops focus to the page.
 */
export function ShowMoreButton({
  loading = false,
  onClick,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'type' | 'onClick'> & {
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={() => {
        if (!loading) {
          onClick();
        }
      }}
      className={cn(
        '-ml-1 flex min-h-11 items-center rounded-md border-0 bg-transparent text-label font-medium md:min-h-9',
        FEED_LINK_TEXT,
        FEED_FOCUS_RING,
        'aria-disabled:cursor-default aria-disabled:no-underline aria-disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}
