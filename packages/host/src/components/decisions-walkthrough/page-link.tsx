import { Link } from '@tanstack/react-router';

import { deliveryLink } from '../../lib/record-url';
import type { WalkScope } from './model';

/** The link back to the page the walkthrough opened on: the same address without the mode. */
export function PageLink({ scope, className }: { scope: WalkScope; className?: string }) {
  return scope.kind === 'delivery' ? (
    <Link {...deliveryLink(scope.id)} className={className}>
      Back to {scope.id}
    </Link>
  ) : (
    <Link to="/p/$key" params={{ key: scope.key }} className={className}>
      Back to {scope.key}
    </Link>
  );
}
