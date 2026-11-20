import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { ActionButton } from '../ui/action-button';

/*
 * Notice, the banner half (ADR 0019, MMR-736): use it for a standing state the
 * operator should see until it ends, such as "Offline" or "Update ready". It
 * renders in place, so the page decides where it sits, and says its text to a
 * screen reader as a polite status. An outcome that has passed is a toast.
 */

const TONES = {
  action: 'border-action/30 bg-action/10 text-ink',
  blocked: 'border-status-blocked/40 bg-status-blocked/15 text-status-blocked-foreground',
} as const;

export type NoticeBannerProps = {
  tone?: keyof typeof TONES;
  children: ReactNode;
  /** The one thing the operator can do about it. */
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** A line under the message, such as why the action failed. */
  detail?: ReactNode;
  className?: string;
};

export function NoticeBanner({
  tone = 'action',
  children,
  action,
  detail,
  className,
}: NoticeBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs font-semibold',
        TONES[tone],
        className,
      )}
    >
      <span>{children}</span>
      {action !== undefined && (
        <ActionButton
          size="sm"
          variant="outline"
          disabled={action.disabled}
          onClick={() => {
            action.onClick();
          }}
        >
          {action.label}
        </ActionButton>
      )}
      {detail !== undefined && detail !== null && (
        <span className="basis-full text-center">{detail}</span>
      )}
    </div>
  );
}
