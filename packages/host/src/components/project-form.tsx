import type { EngineNode } from '@mimir/contract';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { proseEdit } from '../lib/prose';
import { suggestKey } from '../lib/project-key';
import {
  FormField,
  FormGroup,
  FormSheet,
  FormTextArea,
  FormTextInput,
} from './patterns/form-sheet';
import { ActionButton } from './ui/action-button';

/** What the edit form reads off a project: the fields it edits. */
export type EditedProject = Pick<EngineNode, 'id' | 'title' | 'description'>;

export type ProjectFormValues = {
  title: string;
  /** `null` clears the description; `undefined` leaves it. */
  description?: string | null;
};

/** What creating a project sends. */
export type NewProjectValues = { key: string; name: string; description?: string };

type CreateMode = {
  mode: 'create';
  /** Sends the new project; returns the call's promise, so the sheet holds while it runs. */
  onCreate: (values: NewProjectValues) => Promise<unknown>;
};

type EditMode = {
  mode: 'edit';
  project: EditedProject;
  /** Saves the edit; returns the call's promise. */
  onSave: (values: ProjectFormValues) => Promise<unknown>;
  /** The Lifecycle group's Archive: an undoable action that runs at once (ADR 0019, rule 4). */
  onArchive: () => void;
  archiving: boolean;
  offline: boolean;
};

export type ProjectFormProps = {
  open: boolean;
  onClose: () => void;
} & (CreateMode | EditMode);

/**
 * The project form (MMR-230, MMR-743): one form for creating and editing a
 * project, in the Form sheet. Both label the name Title. Creating adds Key, a
 * suggestion derived from Title until the operator edits it, permanent once
 * made since it names every ID; the server owns its uniqueness, so a refusal
 * toasts and the form stays. Editing names the project's key in the context
 * line and ends with Lifecycle, whose Archive needs no confirm: the Notice's
 * Undo is the safety (ADR 0015).
 */
export function ProjectForm(props: ProjectFormProps) {
  const { open, onClose } = props;
  const editing = props.mode === 'edit' ? props.project : undefined;
  const [title, setTitle] = useState(editing?.title ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [key, setKey] = useState('');
  // Once the operator touches Key it stops tracking Title; clearing it resumes.
  const [keyEdited, setKeyEdited] = useState(false);

  const trimmedTitle = title.trim();
  const trimmedKey = key.trim();
  const canSend = trimmedTitle !== '' && (props.mode === 'edit' || trimmedKey !== '');

  const send = () => {
    if (props.mode === 'create') {
      const body = description.trim();
      return props.onCreate({
        ...(body === '' ? {} : { description: body }),
        key: trimmedKey,
        name: trimmedTitle,
      });
    }
    return props.onSave({
      description: proseEdit(description.trim(), props.project.description),
      title: trimmedTitle,
    });
  };

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title={props.mode === 'create' ? 'New project' : 'Project settings'}
      context={
        editing === undefined ? undefined : (
          <>
            Project key <span className="ml-1 font-mono">{editing.id}</span>
          </>
        )
      }
      note={props.mode === 'create' ? 'Joins the project list on the review page.' : undefined}
      commitLabel={props.mode === 'create' ? 'Create project' : 'Save'}
      commitDisabled={!canSend}
      pending={props.mode === 'edit' && props.archiving}
      onCommit={async () => {
        await send();
      }}
    >
      <FormField label="Title">
        <FormTextInput
          name="title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            if (props.mode === 'create' && !keyEdited) {
              setKey(suggestKey(event.target.value));
            }
          }}
        />
      </FormField>
      {props.mode === 'create' && (
        <FormField label="Key" help={<KeyHelp projectKey={trimmedKey} />}>
          <FormTextInput
            name="key"
            value={key}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setKeyEdited(event.target.value !== '');
              setKey(event.target.value);
            }}
            className="w-32 font-mono tracking-[0.02em]"
          />
        </FormField>
      )}
      <FormField label="Description" optional>
        <FormTextArea
          name="description"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </FormField>
      {props.mode === 'edit' && (
        <Lifecycle
          onArchive={props.onArchive}
          disabled={props.offline || props.archiving}
        />
      )}
    </FormSheet>
  );
}

/**
 * Key's help: the one line that says the key is permanent. It quotes the IDs
 * the key will name, `KEY-1` until a key exists; the parenthetical never splits.
 */
function KeyHelp({ projectKey }: { projectKey: string }) {
  const k = projectKey === '' ? 'KEY' : projectKey;
  const id = (n: number): ReactNode => <span className="font-mono">{`${k}-${String(n)}`}</span>;
  return (
    <>
      Suggested from the title. It can’t change later: it names{' '}
      <span className="whitespace-nowrap">
        every ID ({id(1)}, {id(2)}, …).
      </span>
    </>
  );
}

/**
 * Lifecycle (20b): last in the body, in DOM order as on screen. Archive is a
 * neutral outline, since nothing is destroyed; the explanation describes it,
 * so a screen reader hears the no-confirm consequences before pressing it.
 */
function Lifecycle({ onArchive, disabled }: { onArchive: () => void; disabled: boolean }) {
  const explanationId = useId();
  return (
    <FormGroup
      title="Lifecycle"
      explanationId={explanationId}
      explanation="Archiving freezes the project and hides it everywhere by default — board, picker, tasks, attention. Unarchive it from its page, which the project switcher lists under Archived. Reversible any time; nothing is deleted."
    >
      <ActionButton
        size="form"
        variant="formOutline"
        aria-describedby={explanationId}
        disabled={disabled}
        onClick={onArchive}
        className="-mt-1 self-start"
      >
        Archive project
      </ActionButton>
    </FormGroup>
  );
}
