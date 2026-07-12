import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { blockedQuery, doctorQuery, staleQuery, underReviewQuery } from '../api/queries';
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
 * or a solid fill even when the set is blocked-heavy. Selecting an item opens it
 * on its board.
 *
 * Record damage (MMR-185) rides *below* the needs-you set as an amber line per
 * project — a project vital, deliberately not an alarm: it never inflates the
 * "N for you" count and stays amber, never violet or red. When nothing needs the
 * operator but records are dropped, the pill still appears, amber, showing the
 * dropped count so the menu (and its damage lines) stay reachable. All of it is
 * absent at zero — no needs-you, no damage, no pill.
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
  const health = useQuery(doctorQuery());
  const items = attentionItems(
    underReview.data?.items ?? [],
    blocked.data?.items ?? [],
    stale.data?.items ?? [],
  );
  const count = items.length;
  const damaged = (health.data?.groups ?? []).filter((g) => g.dropped > 0);
  const droppedTotal = health.data?.dropped_total ?? 0;

  // Absent at zero: nothing needs you AND nothing is dropped — no pill.
  if (count === 0 && droppedTotal === 0) {
    return null;
  }

  // Amber-only when the sole reason to appear is record damage — a calm vital, not
  // an "N for you" alarm.
  const amberOnly = count === 0;

  return (
    <MenuRoot>
      <MenuTrigger
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-[11px] py-[5px] text-tag font-semibold inset-ring transition-colors focus-visible:outline-2 focus-visible:outline-accent',
          amberOnly
            ? 'bg-status-in-progress/12 text-status-in-progress-foreground inset-ring-status-in-progress/30 hover:bg-status-in-progress/16'
            : 'bg-attention/12 text-attention-foreground inset-ring-attention/24 hover:bg-attention/16',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            amberOnly ? 'bg-status-in-progress' : 'bg-attention',
          )}
        />
        {amberOnly ? `${droppedTotal} dropped` : `${count} for you`}
      </MenuTrigger>
      <MenuContent className="max-h-[70vh] w-[340px] overflow-auto">
        {count > 0 && (
          <div className="border-b border-line px-2 py-1.5 font-mono text-micro font-semibold tracking-[0.13em] text-ink-faint uppercase">
            Needs you · {count}
          </div>
        )}
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
        {/* Record damage sits BELOW the needs-you set (MMR-185), amber, one line per
            damaged project — a vital, never an alarm. */}
        {damaged.map((group) => (
          <MenuItem
            key={group.project}
            className={cn('items-center', count > 0 && 'border-t border-status-in-progress/15')}
            onClick={() => void navigate({ search: { project: group.project }, to: '/doctor' })}
          >
            <span
              aria-hidden
              className="inline-block size-[7px] shrink-0 rounded-full bg-status-in-progress"
            />
            <span className="min-w-0 flex-1 text-[12.5px] text-status-in-progress-foreground">
              Record damage in <span className="font-mono">{group.project}</span> — {group.dropped}{' '}
              dropped
            </span>
            <span className="shrink-0 text-micro text-ink-faint">health →</span>
          </MenuItem>
        ))}
      </MenuContent>
    </MenuRoot>
  );
}
