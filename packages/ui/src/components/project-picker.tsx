import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { projectsQuery, readyQuery } from '../api/queries';
import { connectivity } from '../lib/connectivity';
import { countByProject } from '../lib/counts';
import { NewProjectSheet } from './new-project-sheet';
import { StatusDot } from './status-dot';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from './ui/menu';

/**
 * The project switcher: the sidebar's header (MMR-496). Its button names the
 * current project; its menu lists every project with its status and ready count
 * so you can jump between projects without returning to `/`. A trailing
 * "+ New project" row opens the create-project sheet (MMR-230).
 *
 * This component is the one seam for the searchable switcher (MMR-497): the
 * sidebar mounts nothing else in its header, so replacing this file's menu
 * replaces the switcher.
 */
export function ProjectPicker({
  projectKey,
  onNavigate,
}: {
  projectKey: string;
  /** Called when a menu pick moves the page, so a drawer can close behind it. */
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const projects = useQuery(projectsQuery);
  const ready = useQuery(readyQuery);
  const readyByKey = countByProject(ready.data?.items ?? []);
  const conn = connectivity([projects]);
  const current = projects.data?.items.find((p) => p.id === projectKey);

  return (
    <MenuRoot>
      <MenuTrigger className="flex w-full items-center gap-2 rounded-lg bg-well-850 px-2.5 py-2 text-left inset-ring inset-ring-line-bright transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent">
        {current !== undefined && <StatusDot status={current.status} />}
        <span className="font-mono text-meta font-bold text-ink-bright">{projectKey}</span>
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink-bright">
          {current?.title}
        </span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="shrink-0 text-ink-faint"
        >
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
            className={p.id === projectKey ? 'bg-well-800' : undefined}
            onClick={() => {
              onNavigate?.();
              void navigate({ params: { key: p.id }, to: '/p/$key' });
            }}
          >
            <StatusDot status={p.status} />
            <span className="font-mono text-sm font-semibold text-ink-bright">{p.id}</span>
            <span className="truncate text-sm text-ink md:text-tag">{p.title}</span>
            <span className="ml-auto font-mono text-xs text-ink-dim tabular-nums md:text-tag">
              {readyByKey.get(p.id) ?? 0} ready
            </span>
          </MenuItem>
        ))}
        <MenuItem
          disabled={conn.offline}
          onClick={() => setCreating(true)}
          className="font-medium text-ink-dim data-disabled:opacity-40"
        >
          + New project
        </MenuItem>
      </MenuContent>
      <NewProjectSheet open={creating} onOpenChange={setCreating} />
    </MenuRoot>
  );
}
