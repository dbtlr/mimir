import { Link } from '@tanstack/react-router';
import type { MouseEvent } from 'react';

import { deliveryLink, deliveryPath } from '../../lib/record-url';
import { linkBackAction, useBackToOpener, useOpenerMark } from '../../lib/walkthrough-mark';
import type { WalkScope } from './model';

/** A click the browser would open in the same tab: the primary button with no modifier. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

/**
 * The link back to the page the walkthrough opened on: the same address
 * without the mode. It replaces the walkthrough's history entry, and goes
 * back instead when an entry opened the walkthrough from this very page, so
 * history never holds a second copy of the page (MMR-704 refinement).
 */
export function PageLink({ scope, className }: { scope: WalkScope; className?: string }) {
  const mark = useOpenerMark();
  const back = useBackToOpener();
  const pagePath = scope.kind === 'delivery' ? deliveryPath(scope.id) : `/p/${scope.key}`;
  const onClick = (event: MouseEvent) => {
    if (
      mark !== undefined &&
      linkBackAction(mark.opener, pagePath) === 'back' &&
      isPlainClick(event)
    ) {
      event.preventDefault();
      back(mark);
    }
  };
  return scope.kind === 'delivery' ? (
    <Link {...deliveryLink(scope.id)} replace onClick={onClick} className={className}>
      Back to {scope.id}
    </Link>
  ) : (
    <Link to="/p/$key" params={{ key: scope.key }} replace onClick={onClick} className={className}>
      Back to {scope.key}
    </Link>
  );
}
