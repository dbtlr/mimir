import type { LinkOptions } from '@tanstack/react-router';

/** Where a feed door leads: a router target, so its href is real. */
export type FeedLink = LinkOptions;

/**
 * A feed door's text: accent foreground, underlined on hover. Hover keeps the
 * foreground ink, since `accent` itself falls under 4.5:1 on a light page.
 */
export const FEED_LINK_TEXT = 'text-accent-foreground hover:underline';

/** A focusable feed door's ring, drawn inside its box. */
export const FEED_FOCUS_RING =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-accent';
