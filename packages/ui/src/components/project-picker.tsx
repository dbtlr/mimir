import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { projectsQuery, readyQuery } from "../api/queries";
import { countByProject } from "../lib/counts";
import { StatusDot } from "./status-dot";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "./ui/menu";

/**
 * Top-bar project switcher (MMR-79). Shows the current project key (or
 * "Projects" off the fleet); the menu lists every project with its status and
 * ready count so you can jump between boards without returning to the fleet.
 */
export function ProjectPicker() {
  const navigate = useNavigate();
  // Loose read — the key only exists on the /p/$key route.
  const { key } = useParams({ strict: false }) as { key?: string };
  const projects = useQuery(projectsQuery);
  const ready = useQuery(readyQuery);
  const readyByKey = countByProject(ready.data?.items ?? []);

  return (
    <MenuRoot>
      <MenuTrigger className="flex items-center gap-1 rounded px-2 py-2 font-mono text-[0.8125rem] font-semibold text-ink-bright transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent md:py-1">
        {key ?? "Projects"}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="m6 9 6 6 6-6"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </MenuTrigger>
      <MenuContent className="w-64">
        {(projects.data?.items ?? []).map((p) => (
          <MenuItem
            key={p.id}
            className={p.id === key ? "bg-well-800" : undefined}
            onClick={() => void navigate({ to: "/p/$key", params: { key: p.id } })}
          >
            <StatusDot status={p.status} />
            <span className="font-mono text-[0.8125rem] font-semibold text-ink-bright">{p.id}</span>
            <span className="truncate text-[0.8125rem] text-ink md:text-[0.6875rem]">
              {p.title}
            </span>
            <span className="ml-auto font-mono text-[0.75rem] text-ink-dim tabular-nums md:text-[0.6875rem]">
              {readyByKey.get(p.id) ?? 0} ready
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </MenuRoot>
  );
}
