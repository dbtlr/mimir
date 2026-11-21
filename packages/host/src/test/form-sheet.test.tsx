import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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

/** A form whose first field is disabled. */
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

/** The four-field form the focus scroll cases lay out, open, with its body. */
async function openFourFields(extra?: ReactNode) {
  stubViewport('phone');
  render(
    <Harness>
      {['One', 'Two', 'Three', 'Four'].map((label) => (
        <FormField key={label} label={label}>
          <FormTextInput />
        </FormField>
      ))}
      {extra}
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
  return body;
}

describe('Form sheet focus', () => {
  it('scrolls a field that takes focus below the fold to the rest that shows it whole', async () => {
    const body = await openFourFields();
    // The fifth field, Three, rests at 400, with its control at 452–496 above the 32 end; the
    // rest at 300 would leave the control 4 above the footer.
    act(() => {
      within(body).getByRole('textbox', { name: 'Three' }).focus();
    });
    expect(body.scrollTop).toBe(400);
    vi.restoreAllMocks();
  });

  it('scrolls for a focus the keyboard moves, after a press elsewhere', async () => {
    const body = await openFourFields();
    const three = within(body).getByRole('textbox', { name: 'Three' });
    fireEvent.pointerDown(within(body).getByRole('textbox', { name: 'One' }));
    fireEvent.keyDown(body, { key: 'Tab' });
    act(() => {
      three.focus();
    });
    expect(body.scrollTop).toBe(400);
    vi.restoreAllMocks();
  });

  it('never scrolls for a focus a pointer press gives, so the press lands where it aimed', async () => {
    const body = await openFourFields();
    const three = within(body).getByRole('textbox', { name: 'Three' });
    fireEvent.keyDown(body, { key: 'Tab' });
    fireEvent.pointerDown(three);
    act(() => {
      three.focus();
    });
    expect(body.scrollTop).toBe(0);
    vi.restoreAllMocks();
  });

  it('moves nothing for focus inside a popup a body control opens', async () => {
    // A Select's list in the field below Four, out of view: as a body control it would scroll.
    const popup = (
      <FormField label="Model">
        <div data-slot="select-viewport">
          <button type="button">Claude Opus</button>
        </div>
      </FormField>
    );
    const body = await openFourFields(popup);
    fireEvent.keyDown(body, { key: 'ArrowDown' });
    act(() => {
      within(body).getByRole('button', { name: 'Claude Opus' }).focus();
    });
    expect(body.scrollTop).toBe(0);
    vi.restoreAllMocks();
  });

  it('drops the drawer’s own reveal while focus moves, and takes it otherwise', async () => {
    const scrolls: unknown[] = [];
    // The native scroll the body passes a reveal on to (jsdom has none), recorded rather than run.
    const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollBy');
    Object.defineProperty(Element.prototype, 'scrollBy', {
      configurable: true,
      value: (options: unknown) => {
        scrolls.push(options);
      },
    });
    onTestFinished(() => {
      if (native === undefined) {
        Reflect.deleteProperty(Element.prototype, 'scrollBy');
      } else {
        Object.defineProperty(Element.prototype, 'scrollBy', native);
      }
    });
    const body = await openFourFields();
    const one = within(body).getByRole('textbox', { name: 'One' });
    fireEvent.pointerDown(one);
    // A reveal inside the focus dispatch, as the drawer's `focusin` listener makes one.
    const reveal = () => {
      body.scrollBy({ top: 14 });
    };
    body.parentElement?.addEventListener('focusin', reveal);
    act(() => {
      one.focus();
    });
    body.parentElement?.removeEventListener('focusin', reveal);
    expect(scrolls).toEqual([]);
    // A reveal outside one (a phone keyboard's rise) still scrolls.
    body.scrollBy({ top: 20 });
    expect(scrolls).toEqual([{ top: 20 }]);
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

describe('Form sheet fields', () => {
  it('a text area draws no resize grip', async () => {
    stubViewport('desktop');
    render(<Harness />);
    await openSheet();
    expect(screen.getByRole('textbox', { name: /Description/ })).toHaveClass('resize-none');
    expect(screen.getByRole('textbox', { name: /Description/ })).not.toHaveClass('resize-y');
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

  it('rests a block that opens the body at the top, so the first field keeps the top padding', () => {
    // From `md` up the body's top padding is 32: a rest at 8 would leave the first field 24 down.
    expect(restsOf(blocksAt([32, 120]), false, 32)).toEqual([0, 96]);
  });
});

describe('focus scroll', () => {
  // A body 200 tall over 600 of content, at the top, with blocks resting at 8, 96, 216, and 336.
  // A resize under a keyboard focus holds a control only when it clears the footer by the end.
  const scroll = {
    clientHeight: 200,
    endClearance: 32,
    holdClearance: 32,
    maxScroll: 400,
    rests: [8, 96, 216, 336],
    scrollTop: 0,
  };
  // A focus that just moved stays wherever its field shows whole.
  const moved = { ...scroll, holdClearance: 0 };

  it('leaves a control in view and clear of the footer where it is', () => {
    expect(
      focusScroll({ controlBottom: 100, controlTop: 56, fieldTop: 32, rest: 8 }, scroll),
    ).toBeNull();
  });

  it('leaves a field that just took focus where it is when it shows whole, near the footer or not', () => {
    // The field at 120–192, label and control, ends 8 above the footer: nothing is cut.
    expect(
      focusScroll({ controlBottom: 192, controlTop: 148, fieldTop: 120, rest: 96 }, moved),
    ).toBeNull();
  });

  it('moves a field whose label sits under the header, its control in view, to its rest', () => {
    // Scrolled 40, Title's control at 52–96 shows whole, but its label at 24 sits under the header.
    const under = { ...moved, rests: [0, 96], scrollTop: 40 };
    expect(focusScroll({ controlBottom: 96, controlTop: 52, fieldTop: 24, rest: 0 }, under)).toBe(
      0,
    );
  });

  it('moves a control below the fold to the nearest rest that shows its field whole', () => {
    // The field resting at 216 holds a control at 268–312: 216 shows it 32 clear of the footer.
    expect(
      focusScroll({ controlBottom: 312, controlTop: 268, fieldTop: 240, rest: 216 }, scroll),
    ).toBe(216);
  });

  it('moves a control above the fold back down to its own rest', () => {
    const above = { ...scroll, scrollTop: 336 };
    expect(
      focusScroll({ controlBottom: 192, controlTop: 148, fieldTop: 120, rest: 96 }, above),
    ).toBe(96);
  });

  it('does not hold a control flush with the footer after a resize', () => {
    // A phone's keyboard shrinks the body until the control's bottom sits on the footer.
    const flush = { ...scroll, scrollTop: 112 };
    expect(
      focusScroll({ controlBottom: 312, controlTop: 268, fieldTop: 240, rest: 216 }, flush),
    ).toBe(216);
  });

  it('does not count a control whose outline the footer cuts as in view', () => {
    // The browser's own focus scroll leaves the control's box flush with the footer, its outline past it.
    const flush = { ...moved, scrollTop: 112 };
    expect(
      focusScroll({ controlBottom: 313, controlTop: 267, fieldTop: 240, rest: 216 }, flush),
    ).toBe(216);
  });

  it('of several rests that show the field whole, lands on the one nearest the current scroll', () => {
    // A body 400 tall scrolled to 200, past a control at 150–194: the rests at 0, 40, 80, and
    // 120 all show its field whole, and 120 is the nearest; the lowest and the farthest is 0.
    const tall = { ...scroll, clientHeight: 400, rests: [0, 40, 80, 120], scrollTop: 200 };
    expect(
      focusScroll({ controlBottom: 194, controlTop: 150, fieldTop: 144, rest: 120 }, tall),
    ).toBe(120);
  });

  it('lands on the end when that is the only rest that shows a control past the last block', () => {
    // Archive, after Lifecycle's explanation: no block holds it, and only the end shows it whole.
    expect(
      focusScroll({ controlBottom: 568, controlTop: 524, fieldTop: 524, rest: 500 }, scroll),
    ).toBe(400);
  });

  it('scrolls the least that shows the control whole when no rest does', () => {
    const short = { ...scroll, clientHeight: 80, rests: [8, 300] };
    // The field rests at 200, but there the control at 230–290 ends past an 80 tall body.
    expect(
      focusScroll({ controlBottom: 290, controlTop: 230, fieldTop: 224, rest: 200 }, short),
    ).toBe(210);
  });

  it('scrolls the least that shows the whole field when no rest does, label included', () => {
    // A body 100 tall at 300: the field at 224–290 fits, but no rest keeps the end padding too.
    const short = { ...moved, clientHeight: 100, rests: [8, 300], scrollTop: 300 };
    expect(
      focusScroll({ controlBottom: 290, controlTop: 230, fieldTop: 224, rest: 200 }, short),
    ).toBe(224);
  });

  it('scrolls to the top of a control taller than the body', () => {
    const short = { ...scroll, clientHeight: 80, rests: [] };
    expect(
      focusScroll({ controlBottom: 400, controlTop: 250, fieldTop: 250, rest: 226 }, short),
    ).toBe(250);
  });
});
