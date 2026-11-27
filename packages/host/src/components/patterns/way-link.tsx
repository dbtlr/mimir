import { useLinkProps } from '@tanstack/react-router';
import type { LinkOptions } from '@tanstack/react-router';
import type { AnchorHTMLAttributes } from 'react';

/**
 * A link that leads elsewhere and is never the page: a trail step, a back
 * link, the brand. The router marks a link `aria-current="page"` on its own
 * path and on any path under it, which would give the document a second
 * current page beside the sidebar's row, so this link carries none.
 */
export function WayLink({
  link,
  children,
  ...anchor
}: { link: LinkOptions } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  // The anchor's attributes go through useLinkProps, which composes a caller's
  // handlers with the router's, so an onClick never replaces client navigation.
  const linkProps = useLinkProps({ ...anchor, ...link, activeOptions: { exact: true } });
  return (
    <a {...linkProps} aria-current={undefined}>
      {children}
    </a>
  );
}
