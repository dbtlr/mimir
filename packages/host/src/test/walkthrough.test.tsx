import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  Walkthrough,
  WalkthroughBack,
  WalkthroughBar,
  WalkthroughBody,
  WalkthroughChoices,
  WalkthroughCommit,
  WalkthroughHeading,
  WalkthroughNext,
  WalkthroughNote,
  WalkthroughRow,
} from '../components/patterns/walkthrough';
import { DRAWER_DESKTOP_QUERY } from '../components/ui/drawer';
import { pressAndDropFocus } from './press-and-drop-focus';

const noop = () => undefined;

/** A promise a test settles by hand. */
const deferred = () => Promise.withResolvers<void>();

const CHOICES = [
  { label: 'Keep it', value: 'keep' },
  { detail: 'Drops the rail\nand its tests', label: 'Remove it', value: 'remove' },
  { label: 'Something else', value: 'custom' },
];

type HarnessProps = {
  onCommit?: () => void | Promise<void>;
  onClose?: () => void;
  pending?: boolean;
  commitDisabled?: boolean;
};

/** Two steps of one question each, then a commit on the last. */
function Harness({
  onCommit = noop,
  onClose = noop,
  pending = false,
  commitDisabled = false,
}: HarnessProps) {
  const [step, setStep] = useState(0);
  const [choice, setChoice] = useState('keep');
  const [note, setNote] = useState('');
  return (
    <Walkthrough
      title="Deliver the console"
      progress={`${String(step + 1)} of 2`}
      steps={{ count: 2, current: step }}
      closeLabel="Close the walkthrough"
      onClose={onClose}
      pending={pending}
      screen={`step-${String(step)}`}
      aside={<nav aria-label="Steps">rail</nav>}
    >
      <WalkthroughBody>
        <WalkthroughHeading>
          {step === 0 ? 'First question?' : 'Second question?'}
        </WalkthroughHeading>
        <WalkthroughChoices
          label="Your answer"
          choices={CHOICES}
          value={choice}
          onChange={setChoice}
        />
      </WalkthroughBody>
      <WalkthroughBar>
        <WalkthroughNote label="Add a note" value={note} onChange={setNote} />
        <WalkthroughBack disabled={step === 0} onClick={() => setStep(0)} />
        {step === 0 ? (
          <WalkthroughNext onClick={() => setStep(1)}>Continue</WalkthroughNext>
        ) : (
          <WalkthroughCommit disabled={commitDisabled} onCommit={onCommit} pendingLabel="Sending…">
            Send
          </WalkthroughCommit>
        )}
      </WalkthroughBar>
    </Walkthrough>
  );
}

async function toLastStep() {
  const layer = await screen.findByRole('dialog', { name: 'Deliver the console' });
  await userEvent.click(within(layer).getByRole('button', { name: 'Continue' }));
  await within(layer).findByRole('heading', { name: 'Second question?' });
  return layer;
}

describe('Walkthrough', () => {
  it('is a modal dialog over the whole console, named by its title, with its progress', async () => {
    render(<Harness />);
    const layer = await screen.findByRole('dialog', { name: 'Deliver the console' });
    expect(layer).toHaveAttribute('data-size', 'full');
    expect(layer).toHaveTextContent('1 of 2');
    expect(within(layer).getByRole('navigation', { name: 'Steps' })).toBeInTheDocument();
  });

  it('opens on the heading, and moves focus to each new screen’s heading, never a button', async () => {
    render(<Harness />);
    const layer = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(layer).getByRole('heading', { name: 'First question?' })).toHaveFocus(),
    );
    await userEvent.click(within(layer).getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(within(layer).getByRole('heading', { name: 'Second question?' })).toHaveFocus(),
    );
  });

  it('closes by its Close and by Escape', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const layer = await screen.findByRole('dialog');
    await userEvent.click(within(layer).getByRole('button', { name: 'Close the walkthrough' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('holds Escape and Close while the caller’s call is pending', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} pending />);
    const layer = await screen.findByRole('dialog');
    expect(within(layer).getByRole('button', { name: 'Close the walkthrough' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(layer);
  });

  it('runs a commit once, and holds every control while its promise runs', async () => {
    const call = deferred();
    const onCommit = vi.fn(() => call.promise);
    const onClose = vi.fn();
    render(<Harness onCommit={onCommit} onClose={onClose} />);
    const layer = await toLastStep();
    const send = within(layer).getByRole('button', { name: 'Send' });
    act(() => {
      send.click();
      send.click();
    });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('aria-busy', 'true');
    expect(send).toHaveAccessibleName('Sending…');
    expect(within(layer).getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(within(layer).getByRole('button', { name: 'Close the walkthrough' })).toBeDisabled();
    const note = within(layer).getByRole('textbox', { name: 'Add a note' });
    expect(note).toHaveAttribute('readonly');
    await userEvent.click(within(layer).getByRole('radio', { name: 'Remove it' }));
    expect(within(layer).getByRole('radio', { name: 'Keep it' })).toBeChecked();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      call.resolve();
      await call.promise;
    });
    await waitFor(() => expect(send).toBeEnabled());
    expect(send).toHaveAccessibleName('Send');
    expect(note).not.toHaveAttribute('readonly');
  });

  it('returns focus to the commit after a refusal dropped it', async () => {
    const onCommit = vi.fn().mockRejectedValueOnce(new Error('refused'));
    render(<Harness onCommit={onCommit} />);
    const layer = await toLastStep();
    const send = within(layer).getByRole('button', { name: 'Send' });
    pressAndDropFocus(send);
    await waitFor(() => expect(send).toHaveFocus());
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('holds a disabled commit, as offline, and runs nothing', async () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} commitDisabled />);
    const layer = await toLastStep();
    const send = within(layer).getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await userEvent.click(send);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('WalkthroughNext', () => {
  it('moves one screen for each press, since it writes nothing', async () => {
    render(<Harness />);
    const layer = await screen.findByRole('dialog');
    const next = within(layer).getByRole('button', { name: 'Continue' });
    expect(next).not.toHaveAttribute('aria-busy');
    act(() => {
      next.click();
    });
    expect(within(layer).getByRole('heading', { name: 'Second question?' })).toBeInTheDocument();
  });

  it('holds while the caller’s call is pending', async () => {
    render(<Harness pending />);
    const layer = await screen.findByRole('dialog');
    expect(within(layer).getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});

describe('WalkthroughChoices', () => {
  it('is a named radio group whose arrow keys move the selection', async () => {
    render(<Harness />);
    const layer = await screen.findByRole('dialog');
    const group = within(layer).getByRole('radiogroup', { name: 'Your answer' });
    const keep = within(group).getByRole('radio', { name: 'Keep it' });
    expect(keep).toBeChecked();
    keep.focus();
    await userEvent.keyboard('{ArrowDown}');
    const remove = within(group).getByRole('radio', { name: 'Remove it' });
    expect(remove).toBeChecked();
    expect(remove).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(keep).toBeChecked();
  });

  it('describes an option by its detail, kept out of its name, and selects it from a tap on the detail', async () => {
    render(<Harness />);
    const layer = await screen.findByRole('dialog');
    const remove = within(layer).getByRole('radio', { name: 'Remove it' });
    expect(remove).toHaveAccessibleDescription('Drops the rail\nand its tests');
    expect(within(layer).getByRole('radio', { name: 'Keep it' })).not.toHaveAttribute(
      'aria-describedby',
    );
    const detail = within(layer).getByText(/Drops the rail/);
    expect(detail).toHaveClass('line-clamp-2', 'md:line-clamp-3', 'whitespace-pre-line');
    await userEvent.click(detail);
    expect(remove).toBeChecked();
    expect(detail).not.toHaveClass('line-clamp-2');
  });
});

describe('WalkthroughNote', () => {
  it('is a text box that starts one line tall and grows', async () => {
    render(<Harness />);
    const layer = await screen.findByRole('dialog');
    const note = within(layer).getByRole('textbox', { name: 'Add a note' });
    expect(note).toHaveAttribute('rows', '1');
    await userEvent.type(note, 'Agreed');
    expect(note).toHaveValue('Agreed');
  });
});

/** A matchMedia whose desktop query matches or not, as the viewport is at least `md` or not. */
function stubViewport(desktop: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener: noop,
    matches: desktop && query === DRAWER_DESKTOP_QUERY,
    media: query,
    removeEventListener: noop,
  }));
}

/** One screen whose bar holds Back, a note, and the commit, in a WalkthroughRow. */
function RowHarness() {
  const [note, setNote] = useState('');
  return (
    <Walkthrough title="Row" closeLabel="Close" onClose={noop} screen="one">
      <WalkthroughBody>
        <WalkthroughHeading>Question?</WalkthroughHeading>
      </WalkthroughBody>
      <WalkthroughBar>
        <WalkthroughRow
          back={<WalkthroughBack />}
          note={<WalkthroughNote label="Add a note" value={note} onChange={setNote} />}
        >
          <WalkthroughNext>Continue</WalkthroughNext>
        </WalkthroughRow>
      </WalkthroughBar>
    </Walkthrough>
  );
}

/** The bar's controls, in DOM order, by name. */
function barOrder(layer: HTMLElement): string[] {
  const bar = layer.querySelector('footer')!;
  return [...bar.querySelectorAll('button, textarea')].map(
    (control) => control.getAttribute('aria-label') ?? control.textContent ?? '',
  );
}

describe('WalkthroughRow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('on a phone, puts the note in a row of its own before Back and the commit, in the DOM', async () => {
    stubViewport(false);
    render(<RowHarness />);
    const layer = await screen.findByRole('dialog');
    expect(barOrder(layer)).toStrictEqual(['Add a note', 'Back', 'Continue']);
    const note = within(layer).getByRole('textbox', { name: 'Add a note' });
    const back = within(layer).getByRole('button', { name: 'Back' });
    expect(note.parentElement).not.toBe(back.parentElement);
    // No CSS `order` puts it there: no class sets one.
    const ordered = [...layer.querySelectorAll('*')].filter((el) =>
      [...el.classList].some((name) => /(^|:)order-/.test(name)),
    );
    expect(ordered).toStrictEqual([]);
  });

  it('from md up, keeps Back, the note, and the commit in one row, in that order', async () => {
    stubViewport(true);
    render(<RowHarness />);
    const layer = await screen.findByRole('dialog');
    expect(barOrder(layer)).toStrictEqual(['Back', 'Add a note', 'Continue']);
    const note = within(layer).getByRole('textbox', { name: 'Add a note' });
    const back = within(layer).getByRole('button', { name: 'Back' });
    expect(note.parentElement).toBe(back.parentElement);
  });
});

describe('Walkthrough header', () => {
  it('sets the layer top bar height on the root while open, for the phone Notice, and clears it on close', async () => {
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    measured.mockImplementation(function headerRect(this: HTMLElement) {
      return this.tagName === 'HEADER' ? new DOMRect(0, 0, 390, 69) : new DOMRect();
    });
    onTestFinished(() => {
      measured.mockRestore();
    });
    const root = document.documentElement;
    const { unmount } = render(<Harness />);
    await screen.findByRole('dialog');
    expect(root.style.getPropertyValue('--layer-top-bar-height')).toBe('69px');
    unmount();
    expect(root.style.getPropertyValue('--layer-top-bar-height')).toBe('');
  });

  it('keeps the progress for a screen reader on a phone, where the segmented bar shows it', async () => {
    render(<Harness />);
    const layer = await screen.findByRole('dialog');
    expect(within(layer).getByText('1 of 2')).toHaveClass('max-md:sr-only');
  });
});
