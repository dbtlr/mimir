import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FormField,
  FormGroup,
  FormSheet,
  FormTextArea,
  FormTextInput,
  focusScroll,
  restingRoom,
  restsOf,
} from '../components/patterns/form-sheet';
import { ActionButton } from '../components/ui/action-button';
import { pressAndDropFocus } from './press-and-drop-focus';
import { stubViewport } from './viewport';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A page with an opener and a one-field form, so focus return has somewhere to land. */
const ignore = () => undefined;

function Harness({
  onCommit = ignore,
  context,
  note,
  pending,
  initialFocusOnBody = false,
  children,
}: {
  onCommit?: (title: string) => void | Promise<void>;
  context?: ReactNode;
  note?: ReactNode;
  pending?: boolean;
  initialFocusOnBody?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const body = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <ActionButton onClick={() => setOpen(true)}>Open</ActionButton>
      <FormSheet
        open={open}
        onClose={() => setOpen(false)}
        title="New project"
        context={context}
        note={note}
        commitLabel="Create project"
        commitDisabled={title.trim() === ''}
        pending={pending}
        initialFocus={initialFocusOnBody ? body : undefined}
        onCommit={() => onCommit(title)}
      >
        <FormField label="Title">
          <FormTextInput value={title} onChange={(event) => setTitle(event.target.value)} />
        </FormField>
        <FormField label="Description" optional>
          <FormTextArea ref={body} />
        </FormField>
        {children}
      </FormSheet>
    </>
  );
}

async function openSheet() {
  // A real press, so the opener holds focus when the sheet opens, as it would in a browser.
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
  return screen.findByRole('dialog', { name: 'New project' });
}

const follows = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('Form sheet shapes', () => {
  it('on a phone: full screen, the close in the top bar, the commit alone in the bottom bar', async () => {
    stubViewport('phone');
    render(<Harness note="Joins the project list on the review page." />);
    const sheet = await openSheet();
    expect(sheet).toHaveAttribute('data-side', 'bottom');
    expect(sheet).toHaveAttribute('data-size', 'form');
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Cancel' })).toBeNull();
    const commit = within(sheet).getByRole('button', { name: 'Create project' });
    const note = within(sheet).getByText('Joins the project list on the review page.');
    // The note sits in the bottom bar, one line above the full-width commit.
    expect(follows(note, commit)).toBe(true);
    expect(note.closest('[data-slot="form-sheet-footer"]')).toBe(
      commit.closest('[data-slot="form-sheet-footer"]'),
    );
  });

  it('from md up: a 640 right panel with Cancel then the commit, and the close in its header', async () => {
    stubViewport('desktop');
    render(<Harness />);
    const sheet = await openSheet();
    expect(sheet).toHaveAttribute('data-side', 'right');
    expect(sheet).toHaveAttribute('data-size', 'form');
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    const cancel = within(sheet).getByRole('button', { name: 'Cancel' });
    const commit = within(sheet).getByRole('button', { name: 'Create project' });
    expect(follows(cancel, commit)).toBe(true);
  });

  it('shows a context line only when the form acts on an existing record', async () => {
    stubViewport('desktop');
    const { unmount } = render(<Harness />);
    const fresh = await openSheet();
    expect(fresh).not.toHaveAccessibleDescription();
    unmount();
    render(<Harness context="Project key MMR" />);
    const existing = await openSheet();
    expect(within(existing).getByText('Project key MMR')).toBeInTheDocument();
    expect(existing).toHaveAccessibleDescription('Project key MMR');
  });

  it('the footer note describes the commit, as what the commit leads to', async () => {
    stubViewport('desktop');
    render(<Harness note="Joins the project list on the review page." />);
    const sheet = await openSheet();
    expect(
      within(sheet).getByRole('button', { name: 'Create project' }),
    ).toHaveAccessibleDescription('Joins the project list on the review page.');
  });

  it('keeps the header and footer out of the body, which alone scrolls', async () => {
    stubViewport('desktop');
    render(<Harness />);
    const sheet = await openSheet();
    const body = sheet.querySelector('[data-slot="form-sheet-body"]');
    expect(body).not.toBeNull();
    expect(
      within(body as HTMLElement).queryByRole('button', { name: 'Create project' }),
    ).toBeNull();
    expect(within(body as HTMLElement).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(within(body as HTMLElement).getByRole('textbox', { name: 'Title' })).toBeInTheDocument();
  });

  it('casts the header shadow once the body scrolls, and drops it back at the top', async () => {
    stubViewport('desktop');
    render(<Harness />);
    const sheet = await openSheet();
    const header = sheet.querySelector('[data-slot="form-sheet-header"]');
    const body = sheet.querySelector('[data-slot="form-sheet-body"]') as HTMLElement;
    expect(header).not.toHaveAttribute('data-scrolled');
    body.scrollTop = 40;
    fireEvent.scroll(body);
    expect(header).toHaveAttribute('data-scrolled');
    body.scrollTop = 0;
    fireEvent.scroll(body);
    expect(header).not.toHaveAttribute('data-scrolled');
  });
});

/** A rect 300 wide at `top`, for a layout jsdom lacks. */
const rectAt = (top: number, height: number) =>
  DOMRect.fromRect({ height, width: 300, x: 0, y: top });

describe('Form sheet focus', () => {
  it('scrolls a field that takes focus below the fold to the rest that shows it whole', async () => {
    stubViewport('phone');
    render(
      <Harness>
        {['One', 'Two', 'Three', 'Four'].map((label) => (
          <FormField key={label} label={label}>
            <FormTextInput />
          </FormField>
        ))}
      </Harness>,
    );
    const sheet = await openSheet();
    const body = sheet.querySelector<HTMLElement>('[data-slot="form-sheet-body"]');
    if (body === null) {
      throw new Error('no body');
    }
    // A layout jsdom lacks: the body 200 tall at 100 over 800 of content with a 32 end, and
    // each field 72 tall, 100 apart from 24, with its control 28 below its top.
    body.style.paddingBottom = '32px';
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 800 });
    const blocks = [...body.querySelectorAll<HTMLElement>('[data-form-block]')];
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function layout(
      this: HTMLElement,
    ) {
      if (this === body) {
        return rectAt(100, 200);
      }
      const index = blocks.findIndex((block) => block === this || block.contains(this));
      if (index === -1) {
        return DOMRect.fromRect();
      }
      const top = 100 + 24 + index * 100 - body.scrollTop;
      return blocks[index] === this ? rectAt(top, 72) : rectAt(top + 28, 44);
    });
    // The fifth field, Three, rests at 400, with its control at 452–496 above the 32 end; the
    // rest at 300 would leave the control 4 above the footer.
    act(() => {
      within(body).getByRole('textbox', { name: 'Three' }).focus();
    });
    expect(body.scrollTop).toBe(400);
    vi.restoreAllMocks();
  });

  it.each(['phone', 'desktop'] as const)('opens on the first field (%s)', async (width) => {
    stubViewport(width);
    render(<Harness />);
    await openSheet();
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
    });
  });

  it('opens on the first field that can take focus, past a disabled one', async () => {
    stubViewport('desktop');
    function Locked() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <ActionButton onClick={() => setOpen(true)}>Open</ActionButton>
          <FormSheet
            open={open}
            onClose={() => setOpen(false)}
            title="New project"
            commitLabel="Create project"
            onCommit={ignore}
          >
            <FormField label="Key">
              <FormTextInput disabled defaultValue="MMR" />
            </FormField>
            <FormField label="Title">
              <FormTextInput />
            </FormField>
          </FormSheet>
        </>
      );
    }
    render(<Locked />);
    await openSheet();
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
    });
  });

  it('opens on the field a form names, when that is not the first', async () => {
    stubViewport('desktop');
    render(<Harness initialFocusOnBody />);
    await openSheet();
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /Description/ })).toHaveFocus();
    });
  });

  it.each(['Cancel', 'Close'])('returns focus to the opener on %s', async (name) => {
    stubViewport('desktop');
    render(<Harness />);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole('button', { name }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  it('returns focus to the opener after a commit resolves', async () => {
    stubViewport('desktop');
    render(<Harness onCommit={() => Promise.resolve()} />);
    const sheet = await openSheet();
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Title' }), 'Signal');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Create project' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  it('a refused commit keeps the sheet and its values, and returns dropped focus to the commit', async () => {
    stubViewport('desktop');
    const refused = Promise.withResolvers<void>();
    render(<Harness onCommit={() => refused.promise} />);
    const sheet = await openSheet();
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Signal' },
    });
    const commit = within(sheet).getByRole('button', { name: 'Create project' });
    pressAndDropFocus(commit);
    await act(async () => {
      refused.reject(new Error('taken'));
      await refused.promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(commit).toHaveFocus();
    });
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeInTheDocument();
    expect(within(sheet).getByRole('textbox', { name: 'Title' })).toHaveValue('Signal');
  });
});

describe('Form sheet commit', () => {
  it('holds the commit disabled until the form can be sent, drawn quiet rather than faded', async () => {
    stubViewport('desktop');
    render(<Harness />);
    const sheet = await openSheet();
    const commit = within(sheet).getByRole('button', { name: 'Create project' });
    expect(commit).toBeDisabled();
    expect(commit.className).not.toMatch(/(^|\s)disabled:opacity-/);
    expect(commit.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['disabled:bg-well-800', 'disabled:text-ink-dim']),
    );
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Signal' },
    });
    expect(commit).toBeEnabled();
  });

  it('commits once per opening, however fast it is pressed', async () => {
    stubViewport('desktop');
    const onCommit = vi.fn(() => Promise.withResolvers<void>().promise);
    render(<Harness onCommit={onCommit} />);
    const sheet = await openSheet();
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Signal' },
    });
    const commit = within(sheet).getByRole('button', { name: 'Create project' });
    act(() => {
      commit.click();
      commit.click();
    });
    fireEvent.submit(commit.closest('form') as HTMLFormElement);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith('Signal');
  });

  it('Enter in a field sends the form, and a form that cannot be sent ignores it', async () => {
    stubViewport('desktop');
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const sheet = await openSheet();
    const title = within(sheet).getByRole('textbox', { name: 'Title' });
    await userEvent.type(title, '{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.type(title, 'Signal{Enter}');
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('holds Escape, Cancel, and the close while a commit is pending, and closes once it resolves', async () => {
    stubViewport('desktop');
    const pending = Promise.withResolvers<void>();
    render(<Harness onCommit={() => pending.promise} />);
    const sheet = await openSheet();
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Signal' },
    });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Create project' }));
    await waitFor(() => {
      expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(within(sheet).getByRole('button', { name: 'Create project' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeInTheDocument();
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('holds Escape while the caller reports its own call pending', async () => {
    stubViewport('phone');
    render(<Harness pending />);
    const sheet = await openSheet();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'New project' })).toBe(sheet);
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeDisabled();
  });

  it('Escape closes it while nothing is pending', async () => {
    stubViewport('phone');
    render(<Harness />);
    await openSheet();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('Form sheet groups', () => {
  it('a collapsible group starts folded and opens on its heading', async () => {
    stubViewport('desktop');
    render(
      <Harness>
        <FormGroup title="Advanced" collapsible>
          <FormField label="Branch" optional>
            <FormTextInput />
          </FormField>
        </FormGroup>
      </Harness>,
    );
    const sheet = await openSheet();
    const heading = within(sheet).getByRole('button', { name: 'Advanced' });
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(within(sheet).queryByRole('textbox', { name: /Branch/ })).toBeNull();
    await userEvent.click(heading);
    expect(within(sheet).getByRole('textbox', { name: /Branch/ })).toBeInTheDocument();
  });

  it('a group heads its explanation, which describes nothing on its own', async () => {
    stubViewport('desktop');
    render(
      <Harness>
        <FormGroup title="Lifecycle" explanation="Reversible any time; nothing is deleted." />
      </Harness>,
    );
    const sheet = await openSheet();
    expect(within(sheet).getByRole('heading', { name: 'Lifecycle' })).toBeInTheDocument();
    expect(within(sheet).getByText('Reversible any time; nothing is deleted.')).toBeInTheDocument();
  });
});

/** Blocks 48 tall at these tops, as a body's scroll space measures them. */
const blocksAt = (tops: readonly number[]) => tops.map((top) => ({ bottom: top + 48, top }));

/** The rests of blocks 48 tall at 32, 120, and 240: 8, 96, and 216. */
const REST_AT = restsOf(blocksAt([32, 120, 240]), false);

describe('resting scroll room', () => {
  it('adds nothing when the body does not scroll', () => {
    expect(restingRoom(0, REST_AT)).toBe(0);
  });

  it('adds nothing when the natural end already rests a block 24 below the header', () => {
    expect(restingRoom(96, REST_AT)).toBe(0);
  });

  it('adds the room that carries the end to the next block, rather than cut a field', () => {
    // The end at 70 would leave the block at 120 cut under the header; resting it at 96 needs 26.
    expect(restingRoom(70, REST_AT)).toBe(26);
  });

  it('adds nothing past the last block, where no room helps', () => {
    expect(restingRoom(400, REST_AT)).toBe(0);
  });

  it('carries an end past the last block to where that block hides whole, when content follows it', () => {
    // Lifecycle: its heading ends at 288, and its explanation and Archive follow; an end at
    // 270 would cut the heading, so the end hides it at 288.
    expect(restingRoom(270, restsOf(blocksAt([32, 120, 240]), true))).toBe(18);
  });
});

describe('resting scroll positions', () => {
  it('rests each block a field gap below the header', () => {
    expect(REST_AT).toEqual([8, 96, 216]);
  });

  it('rests a block lower when the gap would show a sliver of the block above it', () => {
    // A group heading ending 20 above its first label: the label rests 20 below, the heading hidden.
    expect(
      restsOf(
        [
          { bottom: 100, top: 76 },
          { bottom: 192, top: 120 },
        ],
        false,
      ),
    ).toEqual([52, 100]);
  });

  it('adds the rest that hides the last block when content that is not a block follows it', () => {
    expect(restsOf(blocksAt([32, 120]), true)).toEqual([8, 96, 168]);
  });
});

describe('focus scroll', () => {
  // A body 200 tall over 600 of content, at the top, with blocks resting at 8, 96, 216, and 336.
  const scroll = {
    clientHeight: 200,
    endClearance: 32,
    maxScroll: 400,
    rests: [8, 96, 216, 336],
    scrollTop: 0,
  };

  it('leaves a control in view and clear of the footer where it is', () => {
    expect(focusScroll({ controlBottom: 100, controlTop: 56, rest: 8 }, scroll)).toBeNull();
  });

  it('moves a control below the fold to the nearest rest that shows its field whole', () => {
    // The field resting at 216 holds a control at 268–312: 216 shows it 32 clear of the footer.
    expect(focusScroll({ controlBottom: 312, controlTop: 268, rest: 216 }, scroll)).toBe(216);
  });

  it('moves a control above the fold back down to its own rest', () => {
    const above = { ...scroll, scrollTop: 336 };
    expect(focusScroll({ controlBottom: 192, controlTop: 148, rest: 96 }, above)).toBe(96);
  });

  it('does not count a control flush with the footer as at rest', () => {
    // The browser's own focus scroll can run first and leave the control's bottom on the footer.
    const flush = { ...scroll, scrollTop: 112 };
    expect(focusScroll({ controlBottom: 312, controlTop: 268, rest: 216 }, flush)).toBe(216);
  });

  it('lands on the end when that is the only rest that shows a control past the last block', () => {
    // Archive, after Lifecycle's explanation: no block holds it, and only the end shows it whole.
    expect(focusScroll({ controlBottom: 568, controlTop: 524, rest: 500 }, scroll)).toBe(400);
  });

  it('scrolls the least that shows the control whole when no rest does', () => {
    const short = { ...scroll, clientHeight: 80, rests: [8, 300] };
    // The field rests at 200, but there the control at 230–290 ends past an 80 tall body.
    expect(focusScroll({ controlBottom: 290, controlTop: 230, rest: 200 }, short)).toBe(210);
  });

  it('scrolls to the top of a control taller than the body', () => {
    const short = { ...scroll, clientHeight: 80, rests: [] };
    expect(focusScroll({ controlBottom: 400, controlTop: 250, rest: 226 }, short)).toBe(250);
  });
});
