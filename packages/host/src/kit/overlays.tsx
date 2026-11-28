import { ActionButton } from '../components/ui/action-button';
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../components/ui/alert-dialog';
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog';
import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerTitle,
  DrawerTrigger,
} from '../components/ui/drawer';
import { Field, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Sample, Section } from './section';

/** Dialog, Alert Dialog, and Drawer: the console's three overlay surfaces. */
export function OverlaysKit() {
  return (
    <>
      <DialogKit />
      <AlertDialogKit />
      <DrawerKit />
    </>
  );
}

function DialogKit() {
  return (
    <Section title="Dialog">
      <Sample label="dialog · default">
        <Dialog>
          <DialogTrigger render={<ActionButton variant="outline" />}>Open dialog</DialogTrigger>
          <DialogBackdrop />
          <DialogContent>
            <DialogTitle>Park MMR-219?</DialogTitle>
            <DialogDescription>
              Parking takes it off the ready queue until you unpark it.
            </DialogDescription>
            <DialogFooter>
              <DialogClose render={<ActionButton size="sm" variant="outline" />}>
                Cancel
              </DialogClose>
              <DialogClose render={<ActionButton size="sm" />}>Park</DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Sample>
      <Sample label="dialog · full (Walkthrough)">
        <Dialog>
          <DialogTrigger render={<ActionButton variant="outline" />}>
            Open full dialog
          </DialogTrigger>
          <DialogContent size="full">
            <DialogTitle>Walkthrough</DialogTitle>
            <DialogDescription>
              A Dialog that covers the whole console at every width.
            </DialogDescription>
            <DialogFooter>
              <DialogClose render={<ActionButton size="sm" variant="outline" />}>Close</DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Sample>
    </Section>
  );
}

function AlertDialogKit() {
  return (
    <Section title="Alert Dialog">
      <Sample label="alert dialog · destructive confirm">
        <AlertDialog>
          <AlertDialogTrigger render={<ActionButton variant="destructiveOutline" />}>
            Stop run
          </AlertDialogTrigger>
          <AlertDialogBackdrop />
          <AlertDialogContent>
            <AlertDialogTitle>Stop this agent run?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent on MMR-219 stops where it is. Its uncommitted work stays in the worktree.
            </AlertDialogDescription>
            <DialogFooter>
              <AlertDialogClose render={<ActionButton size="sm" variant="outline" />}>
                Cancel
              </AlertDialogClose>
              <AlertDialogClose
                render={<ActionButton size="sm" variant="destructiveOutline" />}
                value="confirm"
              >
                Stop run
              </AlertDialogClose>
            </DialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Sample>
    </Section>
  );
}

function DrawerKit() {
  return (
    <Section title="Drawer">
      <Sample label="drawer · content (bottom on a phone, right 440px from md)">
        <Drawer>
          <DrawerTrigger render={<ActionButton variant="outline" />}>Preview MMR-219</DrawerTrigger>
          <DrawerBackdrop />
          <DrawerContent>
            <DrawerTitle>MMR-219</DrawerTitle>
            <DrawerDescription>Park the stale review queue</DrawerDescription>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-meta">
              <dt className="text-ink-dim">Status</dt>
              <dd className="text-ink">In progress</dd>
              <dt className="text-ink-dim">Phase</dt>
              <dd className="text-ink">Console polish</dd>
              <dt className="text-ink-dim">Reason</dt>
              <dd className="text-ink">Waiting on MMR-221 to land</dd>
            </dl>
            <DrawerFooter>
              <DrawerClose render={<ActionButton size="sm" variant="outline" />}>Close</DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </Sample>
      <Sample label="drawer · form (full screen on a phone, right 640px from md)">
        <Drawer>
          <DrawerTrigger render={<ActionButton variant="outline" />}>Block a task</DrawerTrigger>
          <DrawerBackdrop />
          <DrawerContent size="form">
            <DrawerTitle>Block MMR-219</DrawerTitle>
            <DrawerDescription>Say what it is waiting on.</DrawerDescription>
            <Field>
              <FieldLabel>Blocked by</FieldLabel>
              <Input defaultValue="MMR-221" />
            </Field>
            <Field>
              <FieldLabel>Reason</FieldLabel>
              <Textarea grow placeholder="What has to land first?" />
            </Field>
            <DrawerFooter>
              <DrawerClose render={<ActionButton size="sm" variant="outline" />}>
                Cancel
              </DrawerClose>
              <DrawerClose render={<ActionButton size="sm" />}>Block</DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </Sample>
      <Sample label="drawer · left (the Navigation drawer: the sidebar below lg)">
        <Drawer side="left">
          <DrawerTrigger render={<ActionButton variant="outline" />}>Open menu</DrawerTrigger>
          <DrawerBackdrop />
          <DrawerContent size="navigation">
            <DrawerTitle>Mimir</DrawerTitle>
            <DrawerDescription>Jump to a project.</DrawerDescription>
            <nav aria-label="Projects" className="flex flex-col gap-1 text-sm text-ink">
              <a className="rounded-md px-2 py-1.5 hover:bg-well-850" href="#kit">
                Console polish
              </a>
              <a className="rounded-md px-2 py-1.5 hover:bg-well-850" href="#kit">
                Agent runtime
              </a>
            </nav>
          </DrawerContent>
        </Drawer>
      </Sample>
    </Section>
  );
}
