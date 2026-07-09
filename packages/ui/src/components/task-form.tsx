import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { Priority, Size } from '@mimir/contract';
import { useForm } from '@tanstack/react-form';

import type { ParentOption } from '../lib/parent-options';
import { emptyTaskForm, taskFormSchema } from '../lib/schemas';
import type { TaskFormValues } from '../lib/schemas';

export type TaskFormSubmit = {
  parent?: string;
  title: string;
  description: string | null;
  summary: string | null;
  priority: Priority | null;
  size: Size | null;
  external_ref: string | null;
  tags: string[];
};

export type TaskFormProps = {
  mode: 'create' | 'edit';
  parents?: ParentOption[];
  initial?: Partial<TaskFormValues> & { parent?: string };
  submitting?: boolean;
  onSubmit: (values: TaskFormSubmit) => void;
  onCancel: () => void;
};

export function TaskForm({
  mode,
  parents,
  initial,
  submitting,
  onSubmit,
  onCancel,
}: TaskFormProps) {
  const defaultParent = initial?.parent ?? parents?.[0]?.id ?? '';

  const form = useForm({
    defaultValues: {
      ...emptyTaskForm,
      ...initial,
      parent: defaultParent, // always last, always a string
    } satisfies TaskFormValues & { parent: string },
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
      const parsed = result.data;
      if (mode === 'create') {
        onSubmit({ parent: value.parent, ...parsed });
      } else {
        onSubmit(parsed);
      }
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
      {/* Parent picker — create mode only */}
      {mode === 'create' && (
        <div className="flex flex-col gap-1">
          <label htmlFor="task-form-parent" className="text-xs font-medium text-ink-dim">
            Parent
          </label>
          <form.Field name="parent">
            {(field) => (
              <select
                id="task-form-parent"
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent"
              >
                {parents?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.depth === 1 ? `  — ${o.label}` : o.label}
                  </option>
                ))}
              </select>
            )}
          </form.Field>
        </div>
      )}

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

      {/* Summary — short one-line lede for list/board views */}
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
      <details open={mode === 'edit'} className="flex flex-col gap-1">
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

          {/* Tags input — create mode only */}
          {mode === 'create' && (
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
                    value={field.state.value.join(', ')}
                    onChange={(e) => {
                      const raw = e.target.value;
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
          )}
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
        <form.Subscribe
          selector={(state) => ({ parent: state.values.parent, title: state.values.title })}
        >
          {({ title, parent }) => (
            <button
              type="submit"
              disabled={
                submitting === true ||
                title.trim() === '' ||
                (mode === 'create' && (parent ?? '').trim() === '')
              }
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-well-950 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mode === 'create' ? 'Create' : 'Save'}
            </button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
