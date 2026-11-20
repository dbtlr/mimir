import { useState } from 'react';

import { ActionButton } from '../components/ui/action-button';
import {
  Combobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '../components/ui/combobox';
import {
  Command,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../components/ui/command';
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog';
import { Listbox, ListboxItem, PickerRecord } from '../components/ui/listbox';
import { Sample, Section } from './section';

const TASKS = [
  { id: 'MMR-219', title: 'Build the primitives layer on UI SDK' },
  { id: 'MMR-740', title: 'Build the input patterns' },
  { id: 'MMR-736', title: 'Give the console one headless library' },
  { id: 'MMR-711', title: 'Turn on Web Push from Settings' },
];

const PROJECTS = [
  { id: 'MMR', title: 'Mimir' },
  { id: 'FLT', title: 'Fleet' },
  { id: 'NORN', title: 'Norn' },
];

const FIELD = 'flex w-[min(100%,360px)] flex-col gap-1.5';

function TaskCombobox({
  label,
  defaultValue,
  defaultOpen,
  disabled,
}: {
  label: string;
  defaultValue?: string;
  defaultOpen?: boolean;
  disabled?: boolean;
}) {
  return (
    <Combobox
      defaultValue={defaultValue}
      defaultOpen={defaultOpen}
      disabled={disabled}
      itemToLabel={(id) => TASKS.find((task) => task.id === id)?.id ?? id}
    >
      <div className={FIELD}>
        <ComboboxLabel>{label}</ComboboxLabel>
        <div className="relative">
          <ComboboxInput placeholder="Find a task" />
          <ComboboxTrigger aria-label="Show tasks" />
        </div>
      </div>
      <ComboboxContent>
        <ComboboxEmpty />
        <ComboboxList>
          {TASKS.map((task) => (
            <ComboboxItem
              key={task.id}
              value={task.id}
              label={task.id}
              keywords={[task.title]}
              disabled={task.id === 'MMR-711' && label === 'Parent task'}
            >
              <PickerRecord id={task.id} title={task.title} />
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function DependsOnCombobox() {
  return (
    <Combobox multiple defaultValue={['MMR-736', 'MMR-740']} itemToLabel={(id) => id}>
      <div className={FIELD}>
        <ComboboxLabel>Depends on</ComboboxLabel>
        <div className="relative">
          <ComboboxChips>
            <ComboboxValue>
              {(state) =>
                (Array.isArray(state.value) ? state.value : []).map((id: string, index) => (
                  <ComboboxChip key={id} value={id}>
                    {state.labels[index]}
                    <ComboboxChipRemove aria-label={`Remove ${state.labels[index]}`} />
                  </ComboboxChip>
                ))
              }
            </ComboboxValue>
            <ComboboxChipsInput placeholder="Add a task" />
          </ComboboxChips>
          <ComboboxTrigger aria-label="Show tasks" />
        </div>
      </div>
      <ComboboxContent>
        <ComboboxEmpty />
        <ComboboxList>
          {TASKS.map((task) => (
            <ComboboxItem key={task.id} value={task.id} label={task.id} keywords={[task.title]}>
              <PickerRecord id={task.id} title={task.title} />
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function JumpCommand({ onAction }: { onAction?: () => void }) {
  return (
    <Command onAction={onAction} autoHighlight>
      <CommandInput
        aria-label="Jump to a record or action"
        placeholder="Jump to a record or action"
      />
      <CommandList className="max-h-72">
        <CommandGroup>
          <CommandGroupLabel>Tasks</CommandGroupLabel>
          {TASKS.slice(0, 3).map((task) => (
            <CommandItem
              key={task.id}
              value={task.id}
              label={`${task.id} ${task.title}`}
              shortcut={task.id === 'MMR-219' ? 'mod+1' : undefined}
            >
              <PickerRecord id={task.id} title={task.title} />
              {task.id === 'MMR-219' && <CommandShortcut>{(state) => state.text}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup>
          <CommandGroupLabel>Projects</CommandGroupLabel>
          {PROJECTS.map((project) => (
            <CommandItem
              key={project.id}
              value={`project-${project.id}`}
              label={`${project.id} ${project.title}`}
            >
              <PickerRecord id={project.id} title={project.title} />
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      <CommandEmpty>No records match your search.</CommandEmpty>
      <CommandFooter>
        <span>↑↓ move</span>
        <span>↵ open</span>
        <span>esc close</span>
      </CommandFooter>
    </Command>
  );
}

/** Combobox, Listbox, and Command: the Record picker primitives. */
export function PickersKit() {
  const [project, setProject] = useState<string | null>('MMR');
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <>
      <Section title="Combobox">
        <Sample label="combobox · closed">
          <TaskCombobox label="Parent task" />
        </Sample>
        <Sample label="combobox · chosen">
          <TaskCombobox label="Parent task" defaultValue="MMR-740" />
        </Sample>
        <Sample label="combobox · open (selected row, disabled row, highlight on hover or arrows)">
          <div className="h-64 w-full">
            <TaskCombobox label="Parent task" defaultValue="MMR-219" defaultOpen />
          </div>
        </Sample>
        <Sample label="combobox · several (depends on)">
          <DependsOnCombobox />
        </Sample>
        <Sample label="combobox · disabled">
          <TaskCombobox label="Parent task" defaultValue="MMR-219" disabled />
        </Sample>
      </Section>
      <Section title="Listbox">
        <Sample label="listbox · single select">
          <Listbox
            aria-label="Project"
            value={project}
            onValueChange={(next) => {
              setProject(next);
            }}
            className="w-[min(100%,360px)]"
          >
            {PROJECTS.map((item) => (
              <ListboxItem key={item.id} value={item.id} disabled={item.id === 'NORN'}>
                <PickerRecord id={item.id} title={item.title} />
              </ListboxItem>
            ))}
          </Listbox>
        </Sample>
      </Section>
      <Section title="Command">
        <Sample label="command · inline">
          <div className="w-[min(100%,620px)] overflow-hidden rounded-2xl border border-line-bright bg-well-850">
            <JumpCommand />
          </div>
        </Sample>
        <Sample label="command · in a Dialog (the jump palette)">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger render={<ActionButton variant="outline" />}>Jump to…</DialogTrigger>
            <DialogBackdrop />
            <DialogContent className="top-16 -translate-y-0 gap-0 overflow-hidden p-0 md:w-[min(620px,calc(100vw-2rem))]">
              <DialogTitle className="sr-only">Jump to a record or action</DialogTitle>
              <JumpCommand
                onAction={() => {
                  setDialogOpen(false);
                }}
              />
            </DialogContent>
          </Dialog>
        </Sample>
      </Section>
    </>
  );
}
