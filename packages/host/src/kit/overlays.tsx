import { ActionButton } from '../components/ui/action-button';
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
import { Sample, Section } from './section';

/** Dialog, Alert Dialog, and Drawer: the console's three overlay surfaces. */
export function OverlaysKit() {
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
