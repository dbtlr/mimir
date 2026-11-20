import { useState } from 'react';

import { ActionButton } from '../components/ui/action-button';
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '../components/ui/menu';
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '../components/ui/popover';
import { Separator } from '../components/ui/separator';
import { createToaster, ToastStack } from '../components/ui/toast';
import { Sample, Section } from './section';

/** Popover, Menu, Separator, and Toast. */
export function PopupsKit() {
  // A queue of the kit's own, so these samples never touch the app's toasts.
  const [toaster] = useState(() => createToaster());

  return (
    <>
      <Section title="Popover">
        <Sample label="popover · anchored panel">
          <Popover>
            <PopoverTrigger render={<ActionButton variant="outline" />}>Needs you</PopoverTrigger>
            <PopoverContent className="gap-2 p-4" align="start">
              <PopoverTitle>2 waiting on you</PopoverTitle>
              <PopoverDescription>Pick a task to jump to its decision.</PopoverDescription>
              <ul className="flex flex-col text-sm">
                <li className="rounded-md px-2 py-1.5 text-ink hover:bg-line-bright">
                  MMR-219 · Choose the retry policy
                </li>
                <li className="rounded-md px-2 py-1.5 text-ink hover:bg-line-bright">
                  MMR-224 · Review the migration
                </li>
              </ul>
              <div className="flex justify-end pt-1">
                <PopoverClose render={<ActionButton size="sm" variant="outline" />}>
                  Close
                </PopoverClose>
              </div>
            </PopoverContent>
          </Popover>
        </Sample>
      </Section>
      <Section title="Menu">
        <Sample label="menu · items, destructive, disabled, submenu">
          <Menu>
            <MenuTrigger render={<ActionButton variant="outline" />}>Actions</MenuTrigger>
            <MenuContent align="start">
              <MenuGroup>
                <MenuGroupLabel>MMR-219</MenuGroupLabel>
                <MenuItem value="start">Start</MenuItem>
                <MenuItem value="park">Park</MenuItem>
                <MenuItem value="block" disabled>
                  Block (needs a reason)
                </MenuItem>
              </MenuGroup>
              <MenuSeparator />
              <MenuSub>
                <MenuSubTrigger>Move to phase</MenuSubTrigger>
                <MenuSubContent>
                  <MenuItem value="phase-1">Phase 1</MenuItem>
                  <MenuItem value="phase-2">Phase 2</MenuItem>
                </MenuSubContent>
              </MenuSub>
              <MenuSeparator />
              <MenuItem value="abandon" destructive>
                Abandon
              </MenuItem>
            </MenuContent>
          </Menu>
        </Sample>
      </Section>
      <Section title="Separator">
        <Sample label="separator · horizontal and vertical">
          <div className="flex w-full flex-col gap-3">
            <Separator />
            <div className="flex h-6 items-center gap-3 text-sm text-ink">
              <span>Ready</span>
              <Separator orientation="vertical" />
              <span>Blocked</span>
              <Separator orientation="vertical" />
              <span>Done</span>
            </div>
          </div>
        </Sample>
      </Section>
      <Section title="Toast">
        <Sample label="toast · notice, action, retry">
          <ActionButton
            variant="outline"
            onClick={() => {
              toaster('Archived MMR-12', {
                action: { label: 'Undo', onAction: () => undefined },
              });
            }}
          >
            Archived (Undo)
          </ActionButton>
          <ActionButton
            variant="outline"
            onClick={() => {
              toaster.error("Couldn't save the reason", {
                action: { label: 'Retry', onAction: () => undefined },
                description: 'The Engine refused the write.',
              });
            }}
          >
            Failed (Retry)
          </ActionButton>
          <ActionButton
            variant="outline"
            onClick={() => {
              toaster('Copied the task id');
            }}
          >
            Plain notice
          </ActionButton>
          <ToastStack toaster={toaster} />
        </Sample>
      </Section>
    </>
  );
}
