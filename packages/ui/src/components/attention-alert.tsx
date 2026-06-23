import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { blockedQuery, staleQuery } from "../api/queries";
import { projectKeyOf } from "../api/types";
import { attentionItems } from "../lib/attention";
import { StaleBadge } from "./signal-badges";
import { StatusDot } from "./status-dot";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "./ui/menu";

/**
 * The global attention control (MMR-80): the cross-project intervention set
 * (blocked + stale) as a count badge + a menu. Lives in the top bar on every
 * route — promoted from the fleet-only strip. Selecting an item opens it on its
 * project board.
 */
export function AttentionAlert() {
  const navigate = useNavigate();
  const blocked = useQuery(blockedQuery);
  const stale = useQuery(staleQuery);
  const items = attentionItems(blocked.data?.items ?? [], stale.data?.items ?? []);
  const count = items.length;

  return (
    <MenuRoot>
      <MenuTrigger
        aria-label={count === 0 ? "Attention: nothing stuck" : `Attention: ${count} stuck`}
        className="relative flex h-9 w-9 items-center justify-center rounded text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent md:h-auto md:w-auto md:p-1.5"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path d="M12 9v4m0 4h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {count > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-blocked px-1 font-mono text-[0.5625rem] font-bold text-well-950 tabular-nums">
            {count}
          </span>
        )}
      </MenuTrigger>
      <MenuContent className="max-h-[70vh] w-80 overflow-auto">
        {count === 0 ? (
          <p className="px-2 py-3 text-center text-[0.75rem] text-ink-faint">
            Nothing needs attention.
          </p>
        ) : (
          items.map(({ node, reason, stale: isStale }) => (
            <MenuItem
              key={node.id}
              onClick={() =>
                void navigate({
                  to: "/p/$key",
                  params: { key: projectKeyOf(node.id) },
                  search: { view: "board", node: node.id },
                })
              }
            >
              <StatusDot status={reason} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[0.6875rem] text-ink-dim md:text-[0.625rem]">
                    {node.id}
                  </span>
                  <span className="truncate text-[0.8125rem] text-ink md:text-[0.75rem]">
                    {node.title}
                  </span>
                </span>
                {node.hold_reason != null && node.hold_reason !== "" && (
                  <span className="truncate text-[0.6875rem] text-ink-faint">
                    {node.hold_reason}
                  </span>
                )}
              </span>
              {isStale && <StaleBadge />}
            </MenuItem>
          ))
        )}
      </MenuContent>
    </MenuRoot>
  );
}
