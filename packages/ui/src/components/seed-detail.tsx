import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { useUpdateSeed } from '../api/mutations';
import { projectsQuery, seedQuery } from '../api/queries';
import type { WireSeed } from '../api/types';
import { ago } from '../lib/time';
import { SeedKindChip } from './seed-kind-chip';
import { SeedVerbs } from './seed-verbs';
import { ActionButton } from './ui/action-button';
import { Skeleton } from './ui/skeleton';

/** A seed lifecycle is "live" (editable) until a terminal verb freezes it. */
function isLive(seed: WireSeed): boolean {
  return seed.lifecycle === 'new' || seed.lifecycle === 'promoted';
}

function RailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="microlabel font-mono text-ink-faint">{label}</span>
      <span className="text-meta text-ink">{children}</span>
    </div>
  );
}

/**
 * The wide reading pane (Meridian 14a, MMR-247) — verbs pinned at the top, the
 * title at a ~640px measure, the body prose, and a right meta rail
 * (requester / filed / project / spawned). The description is editable while
 * the seed is live (the dossier Edit idiom) and frozen once terminal.
 */
export function SeedDetail({
  id,
  onLater,
  offline,
}: {
  id: string;
  onLater: () => void;
  offline?: boolean;
}) {
  const seed = useQuery(seedQuery(id));
  const projects = useQuery(projectsQuery);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const update = useUpdateSeed(id);

  const data = seed.data;

  if (seed.isPending) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (data === undefined) {
    return <p className="p-6 text-xs text-status-blocked">Couldn't load {id}.</p>;
  }

  const live = isLive(data);
  const projectName = projects.data?.items.find((p) => p.id === data.project)?.title;
  const description = data.description ?? '';

  function startEdit() {
    setDraft(description);
    setEditing(true);
  }

  async function save() {
    try {
      await update.mutateAsync({ description: draft.trim() });
      setEditing(false);
    } catch {
      // toasted by the hook; keep the editor open
    }
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_220px]">
      <div className="flex flex-col gap-3.5 border-line px-7 py-5 md:border-r">
        <div className="flex flex-wrap items-center gap-2.5">
          <SeedKindChip kind={data.kind} />
          <span className="font-mono text-mono-id text-ink-faint">{data.id}</span>
          <div className="ml-auto">
            <SeedVerbs seed={data} onLater={onLater} offline={offline} />
          </div>
        </div>

        <h1 className="max-w-[640px] text-dossier leading-[1.4] font-semibold text-ink-bright">
          {data.title}
        </h1>

        <section className="flex max-w-[640px] flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="microlabel font-mono text-ink-faint">Description</span>
            {live && !editing && offline !== true && (
              <button
                type="button"
                onClick={startEdit}
                className="rounded text-micro text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                {description === '' ? '+ add' : 'Edit'}
              </button>
            )}
          </div>
          {editing && (
            <div className="flex flex-col gap-2">
              <textarea
                // autofocus lands in the body editor when Edit opens
                // oxlint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="min-h-32 resize-y rounded-[9px] border border-line-bright bg-well-900 px-3 py-2.5 text-body leading-[1.7] text-ink caret-accent outline-none focus-visible:border-accent/60"
              />
              <div className="flex items-center gap-2">
                <ActionButton size="sm" disabled={update.isPending} onClick={() => void save()}>
                  Save
                </ActionButton>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded px-2 py-1 text-xs text-ink-dim hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {!editing && description === '' && (
            <p className="text-meta text-ink-faint">
              {live ? 'No body yet — the title is the whole seed.' : 'No body.'}
            </p>
          )}
          {!editing && description !== '' && (
            <p className="text-body leading-[1.75] whitespace-pre-wrap text-ink">{description}</p>
          )}
        </section>
      </div>

      <div className="flex flex-col gap-4 bg-well-recessed px-5 py-5">
        <RailField label="REQUESTER">{data.requester ?? 'you'}</RailField>
        <RailField label="FILED">{ago(data.created_at)}</RailField>
        <RailField label="PROJECT">
          <span className="font-mono text-mono-id text-ink-faint">{data.project}</span>
          {projectName !== undefined && <span className="ml-1.5">{projectName}</span>}
        </RailField>
        <RailField label="SPAWNED">
          {data.spawned.length > 0 ? (
            <span className="font-mono text-accent-foreground">{data.spawned.join(', ')}</span>
          ) : (
            <span className="text-ink-faint">nothing yet</span>
          )}
        </RailField>
      </div>
    </div>
  );
}
