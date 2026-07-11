import { useForm } from '@tanstack/react-form';
import { useId, useState } from 'react';

import { useCreateProject } from '../api/mutations';
import { suggestKey } from '../lib/project-key';
import { ActionButton } from './ui/action-button';
import { Sheet, SheetContent, SheetTitle } from './ui/sheet';

/**
 * The create-project sheet (21a / MMR-230), shared by every "+ New project"
 * trigger (Overview header, mobile end-of-list row, project picker). KEY
 * auto-derives from TITLE as an editable suggestion until the user touches
 * it; it is editable *here only* — after create the key is permanent, since
 * it names every ID. The server owns key uniqueness/validity: a rejection
 * toasts verbatim (via the mutation) and the sheet stays open.
 */
export function NewProjectSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {open && (
        <SheetContent aria-describedby={undefined}>
          <NewProjectForm onDone={() => onOpenChange(false)} />
        </SheetContent>
      )}
    </Sheet>
  );
}

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const create = useCreateProject();
  // Once the user touches KEY it stops tracking TITLE; clearing it resumes.
  const [keyEdited, setKeyEdited] = useState(false);
  const helperId = useId();

  const form = useForm({
    defaultValues: { description: '', key: '', title: '' },
    onSubmit: ({ value }) => {
      const title = value.title.trim();
      const key = value.key.trim();
      if (title === '' || key === '') {
        return;
      }
      const description = value.description.trim();
      create.mutate(
        { description: description === '' ? undefined : description, key, name: title },
        { onSuccess: onDone },
      );
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="m-3 flex flex-col gap-3.5 rounded-[14px] border border-line-bright bg-well-850 px-5 py-[18px] light:shadow-overlay"
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <SheetTitle className="microlabel text-accent-foreground">New project</SheetTitle>
        <span className="ml-auto font-mono text-tag text-ink-ghost">esc</span>
      </div>

      {/* TITLE */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-project-title" className="microlabel text-ink-faint">
          Title
        </label>
        <form.Field name="title">
          {(field) => (
            <input
              id="new-project-title"
              type="text"
              name={field.name}
              value={field.state.value}
              onChange={(e) => {
                field.handleChange(e.target.value);
                if (!keyEdited) {
                  form.setFieldValue('key', suggestKey(e.target.value));
                }
              }}
              onBlur={field.handleBlur}
              className="rounded-[10px] border border-accent/35 bg-well-900 px-3.5 py-3 text-card-mobile font-medium text-ink-bright outline-none focus-visible:border-accent"
            />
          )}
        </form.Field>
      </div>

      {/* KEY */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-project-key" className="microlabel text-ink-faint">
          Key
        </label>
        <div className="flex items-center gap-2.5">
          <form.Field name="key">
            {(field) => (
              <input
                id="new-project-key"
                type="text"
                name={field.name}
                value={field.state.value}
                aria-describedby={helperId}
                onChange={(e) => {
                  setKeyEdited(e.target.value !== '');
                  field.handleChange(e.target.value);
                }}
                onBlur={field.handleBlur}
                className="w-[90px] rounded-[9px] border border-line-bright bg-well-900 px-[13px] py-2.5 font-mono text-meta text-ink-bright outline-none focus-visible:border-accent"
              />
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.key}>
            {(key) => {
              const k = key.trim() === '' ? 'KEY' : key.trim();
              return (
                // ink-dim, not the mock's ink-ghost: this is the one warning
                // that the key is permanent — it must clear WCAG AA (ghost on
                // well-850 sits near 2.5:1 in both themes).
                <p id={helperId} className="text-[11.5px] leading-normal text-ink-dim">
                  auto from title · permanent — it names every ID (
                  <span className="font-mono">{k}-1</span>, <span className="font-mono">{k}-2</span>
                  …)
                </p>
              );
            }}
          </form.Subscribe>
        </div>
      </div>

      {/* DESCRIPTION */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-project-description" className="microlabel text-ink-faint">
          Description · optional
        </label>
        <form.Field name="description">
          {(field) => (
            <textarea
              id="new-project-description"
              name={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="What is this project for?"
              className="min-h-10 resize-y rounded-[9px] border border-line-bright bg-well-900 px-[13px] py-2.5 text-meta text-ink outline-none placeholder:text-ink-faint focus-visible:border-accent"
            />
          )}
        </form.Field>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2.5 border-t border-line pt-3.5">
        {/* ink-dim over the mock's ink-ghost — same WCAG AA bump as the KEY helper. */}
        <span className="text-tag text-ink-dim">lands in At rest until work starts moving</span>
        <form.Subscribe selector={(state) => [state.values.title, state.values.key] as const}>
          {([title, key]) => (
            <ActionButton
              type="submit"
              disabled={create.isPending || title.trim() === '' || key.trim() === ''}
              className="ml-auto shrink-0 px-[18px] py-2 text-xs font-bold disabled:cursor-not-allowed"
            >
              Create ↵
            </ActionButton>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
