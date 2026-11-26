import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { EngineNode, EngineTree, Grooming, Priority, Size } from '@mimir/contract';
import { useState } from 'react';

import { useGroom, useMoveNode, useTag, useUntag, useUpdateNode } from '../api/node-mutations';
import { GROOMING_META, GROOMING_ORDER } from '../lib/grooming';
import { parentOptions } from '../lib/parent-options';
import {
  asksQuestions,
  editWrites,
  saveReport,
  saveWaits,
  settle,
  summaryError,
  taskDraft,
  writeError,
} from '../lib/task-edit';
import type { EditField, EditWrite, TaskDraft } from '../lib/task-edit';
import { MarkdownBody } from './markdown-body';
import {
  FormField,
  FormGroup,
  FormGrowTextArea,
  FormProseEditor,
  FormRecordPicker,
  FormSheet,
  FormTextArea,
  FormTextInput,
  FormTokenInput,
  requestFormCommit,
} from './patterns/form-sheet';
import type { FinalFocus } from './patterns/opener';
import { useOpeningKey } from './patterns/opening';
import type { PickerRecord } from './patterns/record-picker';
import { SegmentedControl } from './ui/segmented-control';
import type { SegmentedOption } from './ui/segmented-control';

/*
 * A task's edit sheet (ADR 0019, MMR-731): Edit in its More opens one Form
 * sheet holding everything editable about it. The content fields come first,
 * then Planning (size, priority, grooming while it is todo, and parent) and
 * Links (tags and the external ref). One Save sends only what changed, each
 * through its own write; a Save that partly fails keeps the sheet open on the
 * fields that did not save, and what did joins the snapshot.
 */

const NONE = 'none';

const SIZE_OPTIONS: readonly SegmentedOption<Size | typeof NONE>[] = [
  { label: 'None', value: NONE },
  ...SIZE_VALUES.map((size) => ({
    label: size.charAt(0).toUpperCase() + size.slice(1),
    value: size,
  })),
];

const PRIORITY_OPTIONS: readonly SegmentedOption<Priority | typeof NONE>[] = [
  { label: 'None', value: NONE },
  ...PRIORITY_VALUES.map((priority) => ({ label: priority, mono: true, value: priority })),
];

const GROOMING_OPTIONS: readonly SegmentedOption<Grooming>[] = GROOMING_ORDER.map((state) => {
  const { label } = GROOMING_META[state];
  return { label: label.charAt(0).toUpperCase() + label.slice(1), value: state };
});

/** The task's legal parents for the Record picker: its initiatives, then their phases. */
function parentRecords(tree: EngineTree | undefined): PickerRecord[] {
  const options = tree === undefined ? [] : parentOptions(tree);
  const records = options.map((option) => ({
    group: option.type === 'initiative' ? 'Initiatives' : 'Phases',
    id: option.id,
    title: option.label,
  }));
  return [
    ...records.filter((record) => record.group === 'Initiatives'),
    ...records.filter((record) => record.group === 'Phases'),
  ];
}

export type TaskEditSheetProps = {
  node: EngineNode;
  /** The project's tree, for the Parent picker's initiatives and phases. */
  tree: EngineTree | undefined;
  open: boolean;
  onClose: () => void;
  finalFocus?: FinalFocus;
};

export function TaskEditSheet(props: TaskEditSheetProps) {
  const opening = useOpeningKey(props.open);
  return <TaskEditForm key={`${props.node.id}:${String(opening)}`} {...props} />;
}

/** What a Save that partly failed left: each failed field's error, the footer note, and whether any of it saved. */
type Outcome = {
  errors: Partial<Record<EditField, string>>;
  note: string;
  savedAny: boolean;
};

function TaskEditForm({ node, tree, open, onClose, finalFocus }: TaskEditSheetProps) {
  const [baseline, setBaseline] = useState(() => taskDraft(node));
  const [draft, setDraft] = useState(baseline);
  const [openingTags] = useState(baseline.tags);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const update = useUpdateNode(node.id);
  const tag = useTag(node.id);
  const untag = useUntag(node.id);
  const move = useMoveNode(node.id);
  const groom = useGroom(node.id);
  const change = (next: Partial<TaskDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  };
  const error = (field: EditField) => outcome?.errors[field];

  function send(write: EditWrite): Promise<unknown> {
    switch (write.kind) {
      case 'content': {
        return update.mutateAsync(write.fields);
      }
      case 'tag': {
        return tag.mutateAsync(write.name);
      }
      case 'untag': {
        return untag.mutateAsync(write.name);
      }
      case 'move': {
        return move.mutateAsync(write.to);
      }
      case 'groom': {
        return groom.mutateAsync({ note: write.note, state: write.state });
      }
      default: {
        const exhaustive: never = write;
        return exhaustive;
      }
    }
  }

  async function save() {
    const writes = editWrites(baseline, draft);
    // Every write runs to its end, so one's failure never hides another's.
    const results = await Promise.allSettled(writes.map(send));
    const saved = writes.filter((_, at) => results[at]?.status === 'fulfilled');
    const failed = writes.flatMap((write, at) => {
      const result = results[at];
      if (result?.status !== 'rejected') {
        return [];
      }
      const reason: unknown = result.reason;
      return [{ reason, write }];
    });
    if (failed.length === 0) {
      return;
    }
    setBaseline(settle(baseline, draft, saved));
    if (saved.some((write) => write.kind === 'groom')) {
      change({ groomingPicked: false, questions: '' });
    }
    const errors: Partial<Record<EditField, string>> = {};
    for (const { write, reason } of failed) {
      const { field, message } = writeError(write, reason);
      errors[field] ??= message;
    }
    setOutcome({
      errors,
      note: saveReport(
        saved,
        failed.map((f) => f.write),
      ),
      savedAny: (outcome?.savedAny ?? false) || saved.length > 0,
    });
    throw new Error('Part of the edit did not save.');
  }

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Edit task"
      context={
        <>
          <span className="font-mono">{node.id}</span> {node.title}
        </>
      }
      commitLabel="Save"
      commitDisabled={saveWaits(draft)}
      onCommit={save}
      note={outcome?.note}
      noteTone="error"
      cancelLabel={outcome?.savedAny === true ? 'Close' : 'Cancel'}
      finalFocus={finalFocus}
    >
      <FormField label="Title" error={error('title')}>
        <FormTextInput
          required
          value={draft.title}
          onChange={(event) => {
            change({ title: event.target.value });
          }}
        />
      </FormField>
      <FormField label="Summary" optional error={summaryError(draft) ?? error('summary')}>
        <FormGrowTextArea
          lines={3}
          value={draft.summary}
          onChange={(event) => {
            // A summary is one line: a pasted break joins the line instead.
            change({ summary: event.target.value.replaceAll(/\s*\n\s*/g, ' ') });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              requestFormCommit(event.currentTarget);
            }
          }}
        />
      </FormField>
      <FormField label="Description" optional error={error('description')}>
        <FormProseEditor
          value={draft.description}
          onChange={(event) => {
            change({ description: event.target.value });
          }}
          preview={
            draft.description.trim() === '' ? (
              <p className="text-body text-ink">No description.</p>
            ) : (
              <MarkdownBody breaks size="body">
                {draft.description}
              </MarkdownBody>
            )
          }
        />
      </FormField>
      <FormGroup title="Planning">
        <FormField label="Size" choice error={error('size')}>
          <SegmentedControl
            size="field"
            fit
            ariaLabel="Size"
            options={SIZE_OPTIONS}
            value={draft.size ?? NONE}
            onChange={(value) => {
              change({ size: value === NONE ? null : value });
            }}
          />
        </FormField>
        <FormField label="Priority" choice error={error('priority')}>
          <SegmentedControl
            size="field"
            fit
            ariaLabel="Priority"
            options={PRIORITY_OPTIONS}
            value={draft.priority ?? NONE}
            onChange={(value) => {
              change({ priority: value === NONE ? null : value });
            }}
          />
        </FormField>
        {draft.grooming !== null && (
          <FormField label="Grooming" choice error={error('grooming')}>
            <SegmentedControl
              size="field"
              fit
              ariaLabel="Grooming"
              options={GROOMING_OPTIONS}
              value={draft.grooming}
              onChange={(value) => {
                change({ grooming: value, groomingPicked: true });
              }}
            />
          </FormField>
        )}
        {asksQuestions(draft) && (
          <FormField
            label="Open questions"
            help="Required for Needs answers. Saved as a note on the task."
          >
            <FormTextArea
              required
              value={draft.questions}
              onChange={(event) => {
                change({ questions: event.target.value });
              }}
            />
          </FormField>
        )}
        <FormRecordPicker
          label="Parent"
          records={parentRecords(tree)}
          value={draft.parent}
          onValueChange={(parent) => {
            change({ parent });
          }}
          placeholder="Choose a parent…"
          searchLabel="Find an initiative or phase"
          emptyText="No initiatives or phases match."
          error={error('parent')}
        />
      </FormGroup>
      <FormGroup title="Links">
        <FormField
          label="Tags"
          optional
          help="Press Enter or type a comma to add a tag."
          error={error('tags')}
        >
          <FormTokenInput
            defaultValue={openingTags}
            onValueChange={(tags) => {
              change({ tags });
            }}
          />
        </FormField>
        <FormField label="External ref" optional error={error('externalRef')}>
          <FormTextInput
            value={draft.externalRef}
            onChange={(event) => {
              change({ externalRef: event.target.value });
            }}
          />
        </FormField>
      </FormGroup>
    </FormSheet>
  );
}
