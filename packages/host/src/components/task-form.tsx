import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { Priority, Size } from '@mimir/contract';
import { useForm } from '@tanstack/react-form';
import { useState } from 'react';

import { emptyTaskForm, taskFormSchema } from '../lib/schemas';
import type { TaskFormValues } from '../lib/schemas';
import { ActionButton } from './ui/action-button';

export type TaskFormSubmit = {
  title: string;
  description: string | null;
  summary: string | null;
  priority: Priority | null;
  size: Size | null;
  external_ref: string | null;
  tags: string[];
};

export type TaskFormProps = {
  initial?: Partial<TaskFormValues>;
  submitting?: boolean;
  onSubmit: (values: TaskFormSubmit) => void;
  onCancel: () => void;
};

export function TaskForm({ initial, submitting, onSubmit, onCancel }: TaskFormProps) {
  // The tags box displays exactly what was typed — parsing must never rewrite
  // the text mid-typing (joining the parsed array back would eat a trailing
  // comma, silently merging "ui" + ", feat" into "uifeat"). The raw string
  // lives here; the form field only ever holds the parsed array.
  const [tagsText, setTagsText] = useState(() => (initial?.tags ?? []).join(', '));

  const form = useForm({
    defaultValues: {
      ...emptyTaskForm,
      ...initial,
    } satisfies TaskFormValues,
    onSubmit: ({ value }) => {
      const result = taskFormSchema.safeParse({
        description: value.description,
        external_ref: value.external_ref,
        priority: value.priority,
        size: value.size,
        summary: value.summary,
        tags: value.tags,
        title: value.title,
      });
      if (!result.success) {
        return;
      }
      onSubmit(result.data);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="flex flex-col gap-3"
    >
      {/* Title — always visible */}
      <div className="flex flex-col gap-1">
        <label htmlFor="task-form-title" className="text-xs font-medium text-ink-dim">
          Title
        </label>
        <form.Field name="title">
          {(field) => (
            <input
              id="task-form-title"
              type="text"
              name={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="Task title"
              className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent"
            />
          )}
        </form.Field>
      </div>

      {/* Summary — short one-line lede for list views */}
      <div className="flex flex-col gap-1">
        <label htmlFor="task-form-summary" className="text-xs font-medium text-ink-dim">
          Summary
        </label>
        <form.Field name="summary">
          {(field) => (
            <input
              id="task-form-summary"
              type="text"
              name={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              maxLength={256}
              placeholder="Optional summary"
              className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent"
            />
          )}
        </form.Field>
        <p className="text-micro text-ink-faint">Short one-line lede for list views (optional)</p>
      </div>

      {/* Description — always visible, not behind disclosure (MMR-75) */}
      <div className="flex flex-col gap-1">
        <label htmlFor="task-form-description" className="text-xs font-medium text-ink-dim">
          Description
        </label>
        <form.Field name="description">
          {(field) => (
            <textarea
              id="task-form-description"
              name={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="Optional description"
              className="min-h-20 resize-y rounded border border-line bg-well-850 p-2 text-xs text-ink outline-none focus-visible:border-accent"
            />
          )}
        </form.Field>
      </div>

      {/* More details disclosure */}
      <details open className="flex flex-col gap-1">
        <summary className="cursor-pointer text-xs text-ink-dim hover:text-ink">
          More details
        </summary>
        <div className="mt-2 flex flex-col gap-3">
          {/* Priority */}
          <div className="flex flex-col gap-1">
            <label htmlFor="task-form-priority" className="text-xs font-medium text-ink-dim">
              Priority
            </label>
            <form.Field name="priority">
              {(field) => (
                <select
                  id="task-form-priority"
                  name={field.name}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent"
                >
                  <option value="">—</option>
                  {PRIORITY_VALUES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              )}
            </form.Field>
          </div>

          {/* Size */}
          <div className="flex flex-col gap-1">
            <label htmlFor="task-form-size" className="text-xs font-medium text-ink-dim">
              Size
            </label>
            <form.Field name="size">
              {(field) => (
                <select
                  id="task-form-size"
                  name={field.name}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent"
                >
                  <option value="">—</option>
                  {SIZE_VALUES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
            </form.Field>
          </div>

          {/* External ref */}
          <div className="flex flex-col gap-1">
            <label htmlFor="task-form-external-ref" className="text-xs font-medium text-ink-dim">
              External ref
            </label>
            <form.Field name="external_ref">
              {(field) => (
                <input
                  id="task-form-external-ref"
                  type="text"
                  name={field.name}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="e.g. GH-123"
                  className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent"
                />
              )}
            </form.Field>
          </div>

          {/* Tags (MMR-257: the task page's edit form is the
              tag-edit surface; the retired standalone TagEditor is gone) */}
          <div className="flex flex-col gap-1">
            <label htmlFor="task-form-tags" className="text-xs font-medium text-ink-dim">
              Tags
            </label>
            <form.Field name="tags">
              {(field) => (
                <input
                  id="task-form-tags"
                  type="text"
                  placeholder="Comma-separated tags"
                  value={tagsText}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setTagsText(raw);
                    const tags = raw
                      .split(',')
                      .map((t) => t.trim())
                      .filter((t) => t.length > 0);
                    field.handleChange(tags);
                  }}
                  onBlur={field.handleBlur}
                  className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent"
                />
              )}
            </form.Field>
          </div>
        </div>
      </details>

      {/* Buttons */}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
        >
          Cancel
        </button>
        <form.Subscribe selector={(state) => state.values.title}>
          {(title) => (
            <ActionButton
              type="submit"
              size="sm"
              disabled={submitting === true || title.trim() === ''}
              className="disabled:cursor-not-allowed"
            >
              Save
            </ActionButton>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
