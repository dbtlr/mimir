import type { Distribution } from '@mimir/contract';

import { cn } from '../lib/cn';
import { STATUS_META, STATUS_ORDER } from '../lib/status';

/**
 * The rollup distribution as a segmented hairline bar — segment order and
 * colors come from the one status system, identical on project cards, board
 * headers, and tree containers.
 */
export function DistributionBar({
  distribution,
  className,
}: {
  distribution: Distribution;
  className?: string;
}) {
  const segments = STATUS_ORDER.map((word) => ({
    word,
    count: distribution[word] ?? 0,
  })).filter((s) => s.count > 0);
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) {
    return <div className={cn('h-1 rounded-full bg-well-700', className)} />;
  }
  const title = segments.map((s) => `${STATUS_META[s.word].label} ${String(s.count)}`).join(' · ');
  return (
    <div
      role="img"
      aria-label={title}
      title={title}
      className={cn('flex h-1 gap-px overflow-hidden rounded-full', className)}
    >
      {segments.map((s) => (
        <span
          key={s.word}
          className={cn('h-full', STATUS_META[s.word].dot)}
          style={{ flexGrow: s.count, flexBasis: 0 }}
        />
      ))}
    </div>
  );
}
