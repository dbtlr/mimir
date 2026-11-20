import type { SeedKind } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { createContext, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useFileSeed } from '../api/seed-mutations';
import { projectsQuery } from '../api/shell-queries';
import { useHotkey } from '../lib/use-hotkey';
import { FormField, FormSheet, FormTextArea, requestFormCommit } from './patterns/form-sheet';
import { toast } from './patterns/notice';
import { RecordPicker } from './patterns/record-picker';
import { SegmentedControl } from './ui/segmented-control';

/** The global capture opener, provided by {@link SeedCaptureProvider}. */
const SeedCaptureContext = createContext<(() => void) | null>(null);

/** Open the seed form from anywhere under the provider (nav button, etc.). */
export function useSeedCapture(): () => void {
  const open = useContext(SeedCaptureContext);
  if (open === null) {
    throw new Error('useSeedCapture must be used within a SeedCaptureProvider');
  }
  return open;
}

/** A seed's kinds, in sentence case (MMR-743): the value stays the contract's word. */
const KIND_OPTIONS = [
  { label: 'Idea', value: 'idea' },
  { label: 'Bug', value: 'bug' },
  { label: 'Feature', value: 'feature' },
] as const satisfies readonly { label: string; value: SeedKind }[];

/**
 * Hosts the global "File a seed" form (Meridian 12c, MMR-247) so it works from
 * any surface without leaving it: the seed form in the Form sheet (ADR 0019,
 * MMR-736). Lives in the Shell; the `s` hotkey and any `useSeedCapture()`
 * caller open it. There is no global "+" affordance in the Shell (the authoring
 * sheet's "+ New task" is scoped to the work page's head, MMR-227), so the
 * mobile long-press trigger is deliberately skipped — see the task notes.
 */
export function SeedCaptureProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Each opening starts a fresh form.
  const [opening, setOpening] = useState(0);
  // Guard the hotkey while open — the sheet itself carries role="dialog", so
  // the in-hook dialog check also covers it; disabling is the cheaper belt.
  const openCapture = useMemo(
    () => () => {
      setOpening((n) => n + 1);
      setOpen(true);
    },
    [],
  );
  useHotkey('s', openCapture, { enabled: !open });

  return (
    <SeedCaptureContext.Provider value={openCapture}>
      {children}
      <SeedForm
        key={opening}
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </SeedCaptureContext.Provider>
  );
}

/**
 * Three fields, no more (12c): Kind (default Idea), the capture field, and the
 * project (the current one on `/p/$key` when the picker offers it, none on an
 * archived one, else the first). The capture field is
 * one blob with commit-message semantics (MMR-263): the first line is the
 * title, the rest is the body. Enter files; Shift+Enter adds a newline. Success
 * closes and toasts; a refusal keeps the form and its fields.
 */
function SeedForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { key } = useParams({ strict: false });
  const projects = useQuery(projectsQuery);
  const projectItems = projects.data ?? [];
  // The route's project only when the picker offers it: on an archived or unknown one the
  // picker would show no choice, so the form must not file to it unseen.
  const routeProject = projectItems.some((p) => p.id === key) ? key : undefined;
  const defaultProject = key === undefined ? (projectItems[0]?.id ?? '') : (routeProject ?? '');

  const [kind, setKind] = useState<SeedKind>('idea');
  const [title, setTitle] = useState('');
  const [project, setProject] = useState('');
  const seedField = useRef<HTMLTextAreaElement>(null);

  const file = useFileSeed();
  const effectiveProject = project !== '' ? project : defaultProject;
  const canFile = title.trim() !== '' && effectiveProject !== '';

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="File a seed"
      commitLabel="File seed"
      commitDisabled={!canFile}
      initialFocus={seedField}
      onCommit={async () => {
        // Never send `requester` — a console-filed seed is self-filed (server → "you").
        // Send the whole capture blob as `title`; the server splits the first line
        // off as the title and the rest into the `## Seed Description` body (MMR-263).
        // A refusal is toasted by the hook, and the form stays with its fields.
        const seed = await file.mutateAsync({ kind, project: effectiveProject, title });
        toast.success(`Filed ${seed.id}`);
      }}
    >
      <FormField label="Kind">
        <SegmentedControl<SeedKind>
          size="field"
          ariaLabel="Kind"
          options={KIND_OPTIONS}
          value={kind}
          onChange={setKind}
        />
      </FormField>
      <FormField label="Seed" help="First line is the title. Shift+Enter for a body line.">
        <FormTextArea
          ref={seedField}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter files; Shift+Enter inserts a newline (the body). Guard IME
            // composition so an in-progress candidate commit never files.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              requestFormCommit(event.currentTarget);
            }
          }}
          className="caret-accent"
        />
      </FormField>
      <RecordPicker
        label="Project"
        records={projectItems.map((p) => ({ id: p.id, title: p.title }))}
        value={effectiveProject === '' ? null : effectiveProject}
        onValueChange={setProject}
        placeholder="Choose a project…"
        searchLabel="Find a project"
        emptyText="No projects match."
      />
    </FormSheet>
  );
}
