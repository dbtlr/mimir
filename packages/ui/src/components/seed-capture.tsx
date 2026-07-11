import { Dialog } from '@base-ui-components/react/dialog';
import { SEED_KIND_VALUES } from '@mimir/contract';
import type { SeedKind } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { createContext, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

import { useFileSeed } from '../api/mutations';
import { projectsQuery } from '../api/queries';
import { cn } from '../lib/cn';
import { SEED_KIND_WASH } from '../lib/seed-kind';
import { useHotkey } from '../lib/use-hotkey';
import { ActionButton } from './ui/action-button';

/** The global capture opener, provided by {@link SeedCaptureProvider}. */
const SeedCaptureContext = createContext<(() => void) | null>(null);

/** Open the capture popover from anywhere under the provider (nav button, etc.). */
export function useSeedCapture(): () => void {
  const open = useContext(SeedCaptureContext);
  if (open === null) {
    throw new Error('useSeedCapture must be used within a SeedCaptureProvider');
  }
  return open;
}

/**
 * Hosts the global "file a seed" popover (Meridian 12c, MMR-247) so it works
 * from any surface without leaving it. Lives in the Shell; the `s` hotkey and
 * any `useSeedCapture()` caller open it. There is no global "+" affordance in
 * the Shell (the authoring sheet's "+ New task" is board-header-scoped, MMR-227),
 * so the mobile long-press trigger is deliberately skipped — see the task notes.
 */
export function SeedCaptureProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Guard the hotkey while open — the popup itself carries role="dialog", so
  // the in-hook dialog check also covers it; disabling is the cheaper belt.
  useHotkey('s', () => setOpen(true), { enabled: !open });
  const openCapture = useMemo(() => () => setOpen(true), []);

  return (
    <SeedCaptureContext.Provider value={openCapture}>
      {children}
      <SeedCaptureDialog open={open} onOpenChange={setOpen} />
    </SeedCaptureContext.Provider>
  );
}

function SeedCaptureDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-well-950/70 backdrop-blur-[2px]" />
        <Dialog.Popup className="fixed top-[18%] left-1/2 z-50 flex w-[min(92vw,480px)] -translate-x-1/2 flex-col gap-3 rounded-2xl border border-line-bright bg-well-850 p-4 shadow-2xl outline-none light:shadow-overlay">
          {open && <SeedCaptureForm onClose={() => onOpenChange(false)} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Three fields, no more (12c): kind pills (default `idea`), a single title
 * field, and an optional project select (the current board when on `/p/$key`,
 * else the first project). The body/description is edited later in the detail
 * view — by design it is not captured here. Enter files; success closes,
 * toasts, and resets.
 */
function SeedCaptureForm({ onClose }: { onClose: () => void }) {
  const { key } = useParams({ strict: false });
  const projects = useQuery(projectsQuery);
  const projectItems = projects.data?.items ?? [];
  const defaultProject = key ?? projectItems[0]?.id ?? '';

  const [kind, setKind] = useState<SeedKind>('idea');
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(defaultProject);
  const titleRef = useRef<HTMLInputElement>(null);

  const file = useFileSeed();
  const effectiveProject = project !== '' ? project : defaultProject;
  const canFile = !file.isPending && title.trim() !== '' && effectiveProject !== '';

  function reset() {
    setKind('idea');
    setTitle('');
    setProject(defaultProject);
    titleRef.current?.focus();
  }

  async function submit() {
    if (!canFile) {
      return;
    }
    try {
      // Never send `requester` — a console-filed seed is self-filed (server → "you").
      const seed = await file.mutateAsync({
        kind,
        project: effectiveProject,
        title: title.trim(),
      });
      toast.success(`Filed ${seed.id}`);
      reset();
      onClose();
    } catch {
      // toasted by the hook; the popover stays open with its fields intact
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-3"
    >
      <Dialog.Title className="sr-only">File a seed</Dialog.Title>
      <div className="flex items-center gap-2">
        <span className="microlabel font-mono text-accent-foreground">File a seed</span>
        <Dialog.Close
          aria-label="Close"
          className="ml-auto rounded font-mono text-micro text-ink-ghost hover:text-ink-dim"
        >
          esc
        </Dialog.Close>
      </div>

      <div role="group" aria-label="Kind" className="flex gap-1.5">
        {SEED_KIND_VALUES.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-semibold inset-ring transition-colors',
              kind === k ? SEED_KIND_WASH[k] : 'text-ink-dim inset-ring-line hover:text-ink-bright',
            )}
          >
            {k}
          </button>
        ))}
      </div>

      <input
        ref={titleRef}
        aria-label="Title"
        // autofocus lands on the title the moment the popover opens
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What's the seed?"
        className="rounded-[10px] border border-line-bright bg-well-900 px-3.5 py-2.5 text-card-mobile text-ink-bright caret-accent outline-none placeholder:text-ink-ghost focus-visible:border-accent/60"
      />

      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="seed-capture-project">
          Project
        </label>
        <select
          id="seed-capture-project"
          value={effectiveProject}
          onChange={(e) => setProject(e.target.value)}
          className="rounded-[7px] border border-line bg-well-900 px-2.5 py-1.5 text-meta text-ink-bright outline-none focus-visible:border-accent/60"
        >
          {projectItems.length === 0 && <option value="">No projects</option>}
          {projectItems.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id} — {p.title}
            </option>
          ))}
        </select>
        <span className="text-tag text-ink-ghost">optional</span>
        <ActionButton size="sm" type="submit" disabled={!canFile} className="ml-auto font-bold">
          File ↵
        </ActionButton>
      </div>
    </form>
  );
}
