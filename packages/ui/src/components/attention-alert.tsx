import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { blockedQuery, staleQuery, underReviewQuery } from '../api/queries';
import { projectKeyOf } from '../api/types';
import type { AttentionReason } from '../lib/attention';
import { attentionItems } from '../lib/attention';
import { cn } from '../lib/cn';
import { ago } from '../lib/time';
import { StatusDot } from './status-dot';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from './ui/menu';

/**
 * The global attention control (MMR-80/103, restyled MMR-226): the cross-project
 * set that needs the operator — **under_review (Awaiting you) → blocked →
 * going_cold** — as a calm violet "N for you" pill + a menu. The pill uses the
 * canonical wash+ring ratio (12% fill under a 24% inset ring), never a red hue
 * or a solid fill even when the set is blocked-heavy, and hides entirely at zero
 * ("N for you" is never "0 for you"). Selecting an item opens it on its board.
 */

/** Per-reason label + its status-foreground meta tone. */
const REASON_META: Record<AttentionReason, { label: string; meta: string }> = {
  blocked: { label: 'Blocked', meta: 'text-status-blocked-foreground' },
  going_cold: { label: 'Going cold', meta: 'text-cold' },
  under_review: { label: 'Under review', meta: 'text-status-under-review-foreground' },
};

export function AttentionAlert() {
  const navigate = useNavigate();
  const underReview = useQuery(underReviewQuery);
  const blocked = useQuery(blockedQuery);
  const stale = useQuery(staleQuery);
  const items = attentionItems(
    underReview.data?.items ?? [],
    blocked.data?.items ?? [],
    stale.data?.items ?? [],
  );
  const count = items.length;

  // "N for you" is never "0 for you" — nothing needs you, nothing to show.
  if (count === 0) {
    return null;
  }

  return (
    <MenuRoot>
      <MenuTrigger className="inline-flex items-center gap-1.5 rounded-full bg-attention/12 px-[11px] py-[5px] text-tag font-semibold text-attention-foreground inset-ring inset-ring-attention/24 transition-colors hover:bg-attention/16 focus-visible:outline-2 focus-visible:outline-accent">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
        {count} for you
      </MenuTrigger>
      <MenuContent className="max-h-[70vh] w-[340px] overflow-auto">
        <div className="border-b border-line px-2 py-1.5 font-mono text-micro font-semibold tracking-[0.13em] text-ink-faint uppercase">
          Needs you · {count}
        </div>
        {items.map(({ node, reason }) => {
          const rm = REASON_META[reason];
          return (
            <MenuItem
              key={node.id}
              className="items-start"
              onClick={() =>
                void navigate({
                  params: { key: projectKeyOf(node.id) },
                  search: { node: node.id, view: 'board' },
                  to: '/p/$key',
                })
              }
            >
              {reason === 'going_cold' ? (
                <span
                  aria-hidden
                  className="mt-1 inline-block size-[7px] shrink-0 rounded-full bg-cold"
                />
              ) : (
                <StatusDot status={reason} className="mt-1" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-xs font-medium text-ink-bright">{node.title}</span>
                <span className={cn('text-micro', rm.meta)}>
                  {rm.label} <span className="text-ink-faint">·</span>{' '}
                  <span className="font-mono text-ink-faint">{node.id}</span>{' '}
                  <span className="text-ink-faint">·</span> {ago(node.updated_at)}
                </span>
              </span>
            </MenuItem>
          );
        })}
        {/* Record-damage line rides the doctor facet (MMR-140 line); no query here. */}
      </MenuContent>
    </MenuRoot>
  );
}
