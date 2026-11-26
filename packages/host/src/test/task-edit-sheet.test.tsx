import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNode, groom, move, tag, untag, update } from '../api/fns/nodes';
import { toast } from '../components/patterns/notice';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { engineTree } from './engine-fixtures';
import { engineTag, engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('../components/patterns/notice', async (orig) => ({
  // oxlint-disable-next-line typescript/consistent-type-imports
  ...(await orig<typeof import('../components/patterns/notice')>()),
  toast: { error: vi.fn(), success: vi.fn() },
}));

/*
 * The task edit sheet (ADR 0019, MMR-731), driven from the task page's More:
 * one Form sheet for every field, whose Save sends only what changed, each
 * through its own write, and keeps the sheet open on a write that failed.
 * Typing into the tag box needs a browser (see token-input.test.tsx); a tag
 * added there reaches the same diff as a removed chip (task-edit.test.ts).
 */

const stamp = '2026-06-01T00:00:00.000Z';

const TREE = engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
  engineTree({ id: 'MMR-1', status: 'ready', title: 'Backends', type: 'initiative' }, [
    engineTree({ id: 'MMR-2', parent: 'MMR-1', status: 'ready', title: 'SQLite', type: 'phase' }),
  ]),
  engineTree({ id: 'MMR-3', status: 'ready', title: 'Console', type: 'initiative' }),
]);

const todo = (overrides: Partial<EngineNode> = {}) =>
  engineTask({
    description: 'Old prose.',
    grooming: 'not_groomed',
    id: 'MMR-417',
    parent: 'MMR-2',
    status: 'ready',
    summary: 'A short lede.',
    tags: [engineTag('ui', stamp), engineTag('feed', stamp)],
    title: 'Add the SQLite dialect',
    ...overrides,
  });

beforeEach(() => {
  serveBrowse();
  serveViews();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render the task page for `node`. */
async function openTask(node: EngineNode) {
  serveShell({ trees: { MMR: TREE } });
  const world = serveNodes({ nodes: [node], notes: { [node.id]: [] } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await renderRoute(consoleRoutes, `/p/MMR/${node.id.replace('MMR-', '')}`, client);
  await screen.findByRole('heading', { level: 1 });
  return world;
}

/** More's rows, in order, separators as `—`, Cancel left off. */
async function moreRows() {
  await userEvent.click(await screen.findByRole('button', { name: 'More' }));
  const menu = await screen.findByRole('dialog');
  return [...menu.querySelectorAll('button, [data-slot="separator"], [role="separator"]')]
    .map((el) => (el.tagName === 'BUTTON' ? (el.textContent ?? '') : '—'))
    .filter((row) => row !== 'Cancel');
}

/** Open the task page for `node`, then its edit sheet, and return the sheet. */
async function openSheet(node: EngineNode) {
  await openTask(node);
  return openEdit();
}

/** Open the edit sheet from the open task page's More, and return the sheet. */
async function openEdit() {
  await userEvent.click(await screen.findByRole('button', { name: 'More' }));
  // More is a bottom sheet of buttons on a phone and an anchored menu on desktop.
  await userEvent.click(await screen.findByText('Edit', { selector: 'button, [role="menuitem"]' }));
  return screen.findByRole('dialog', { name: 'Edit task' });
}

/**
 * Open the edit sheet on `node`, whose content updates land in the served
 * world, with every node read after the first update held until `release`.
 */
async function openHeldSheet(node: EngineNode) {
  const world = await openTask(node);
  const served = vi.mocked(getNode).getMockImplementation()!;
  const hold = Promise.withResolvers<void>();
  let wrote = false;
  vi.mocked(getNode).mockImplementation(async (options) => {
    if (wrote) {
      await hold.promise;
    }
    return served(options);
  });
  vi.mocked(update).mockImplementation(async ({ data }) => {
    const { id, ...fields } = data;
    world.nodes = world.nodes.map((n) => (n.id === id ? ({ ...n, ...fields } as EngineNode) : n));
    wrote = true;
    return world.nodes.find((n) => n.id === id)!;
  });
  return { release: hold.resolve, sheet: await openEdit() };
}

/** Let pending promises and the query client's batched notifications run, a few task turns deep. */
async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      // oxlint-disable-next-line no-await-in-loop -- each turn waits for the one before it
      await promise;
    }
  });
}

/** Save `sheet`, check it stays open and busy on the held refetch, then let the refetch land. */
async function saveThroughRefetch(sheet: HTMLElement, release: () => void) {
  await save(sheet);
  await waitFor(() => {
    expect(update).toHaveBeenCalled();
  });
  await settle();
  expect(screen.getByRole('dialog', { name: 'Edit task' })).toBe(sheet);
  expect(within(sheet).getByRole('button', { name: 'Save' })).toHaveAttribute('aria-busy', 'true');
  release();
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
  });
}

const save = (sheet: HTMLElement) =>
  userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));

/** Every write of one kind, by its payload. */
const sent = (fn: typeof update | typeof tag | typeof untag | typeof move | typeof groom) =>
  vi.mocked(fn).mock.calls.map(([options]) => options.data);

describe('task edit sheet: opening and closing', () => {
  it('is More’s one editing row: Move… and Set grooming… are gone', async () => {
    await openTask(todo());
    expect((await moreRows()).slice(0, 2)).toStrictEqual(['Edit', '—']);
  });

  it('heads the sheet Edit task with the ID and saved title, and focuses Title', async () => {
    const sheet = await openSheet(todo());

    expect(within(sheet).getByText('MMR-417')).toHaveClass('font-mono');
    expect(sheet).toHaveAccessibleDescription('MMR-417 Add the SQLite dialect');
    await waitFor(() => {
      expect(within(sheet).getByRole('textbox', { name: 'Title' })).toHaveFocus();
    });
  });

  it('returns focus to More when it closes', async () => {
    const sheet = await openSheet(todo());
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
    });
  });

  it('marks the optional fields, and not Title, Parent, or the choices that always hold a value', async () => {
    const sheet = await openSheet(todo());
    const optional = [...sheet.querySelectorAll('label, span')]
      .filter((el) => el.lastElementChild?.textContent === 'optional')
      .map((el) => el.firstChild?.textContent);
    expect(optional).toStrictEqual(['Summary', 'Description', 'Tags', 'External ref']);
  });
});

describe('task edit sheet: Save sends only what changed', () => {
  it('saves nothing and closes when nothing changed', async () => {
    const sheet = await openSheet(todo());
    await save(sheet);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
    });
    expect(update).not.toHaveBeenCalled();
    expect(tag).not.toHaveBeenCalled();
    expect(untag).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(groom).not.toHaveBeenCalled();
  });

  it('sends the changed content fields in one update, and none of the rest', async () => {
    const sheet = await openSheet(todo({ priority: 'p2', size: 'small' }));
    const title = within(sheet).getByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Add the SQLite store');
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Large' }));
    await userEvent.type(within(sheet).getByRole('textbox', { name: /External ref/ }), 'GH-7');
    await save(sheet);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
    });
    expect(sent(update)).toStrictEqual([
      { externalRef: 'GH-7', id: 'MMR-417', size: 'large', title: 'Add the SQLite store' },
    ]);
    expect(tag).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it('clears a priority with None and an emptied summary and description with null', async () => {
    const sheet = await openSheet(todo({ priority: 'p1' }));
    const priority = within(sheet).getByRole('radiogroup', { name: 'Priority' });
    await userEvent.click(within(priority).getByRole('radio', { name: 'None' }));
    await userEvent.clear(within(sheet).getByRole('textbox', { name: /Summary/ }));
    await userEvent.clear(within(sheet).getByRole('textbox', { name: /Description/ }));
    await save(sheet);

    await waitFor(() => {
      expect(sent(update)).toStrictEqual([
        { description: null, id: 'MMR-417', priority: null, summary: null },
      ]);
    });
  });

  it('untags a removed chip and leaves the kept tag alone', async () => {
    const sheet = await openSheet(todo());
    // A chip's remove is a pointer target; the keyboard deletes a chip as text.
    await userEvent.click(sheet.querySelector('[aria-label="Remove feed"]')!);
    await save(sheet);

    await waitFor(() => {
      expect(sent(untag)).toStrictEqual([{ ids: ['MMR-417'], tags: ['feed'] }]);
    });
    expect(tag).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('moves the task to the parent chosen in the picker, listed initiatives then phases', async () => {
    const sheet = await openSheet(todo());
    await userEvent.click(within(sheet).getByRole('button', { name: /^Parent/ }));
    const groups = await screen.findAllByRole('group');
    expect(groups.map((group) => group.firstElementChild?.textContent)).toStrictEqual([
      'Initiatives',
      'Phases',
    ]);
    await userEvent.click(screen.getByRole('option', { name: /Console/ }));
    await save(sheet);

    await waitFor(() => {
      expect(sent(move)).toStrictEqual([{ id: 'MMR-417', to: 'MMR-3' }]);
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('holds Save on a summary past 256 characters, with the cap under Summary', async () => {
    const sheet = await openSheet(todo());
    const summary = within(sheet).getByRole('textbox', { name: /Summary/ });
    await userEvent.clear(summary);
    await userEvent.click(summary);
    await userEvent.paste('x'.repeat(257));

    expect(summary).toHaveAttribute('aria-invalid', 'true');
    expect(summary).toHaveAccessibleDescription('Summary must be 256 characters or fewer');
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.type(summary, '{Backspace}');
    expect(summary).not.toHaveAttribute('aria-invalid');
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows the description rendered on Preview, as the task page does', async () => {
    const sheet = await openSheet(todo({ description: 'Uses **bun:sqlite**.' }));
    await userEvent.click(within(sheet).getByRole('tab', { name: 'Preview' }));

    const preview = within(sheet).getByRole('tabpanel');
    expect(within(preview).getByText('bun:sqlite').tagName).toBe('STRONG');
  });

  it('shows an empty description on Preview as the task page shows it', async () => {
    const sheet = await openSheet(todo({ description: '' }));
    const onPage = screen.getAllByText('No description.').find((line) => !sheet.contains(line));
    await userEvent.click(within(sheet).getByRole('tab', { name: 'Preview' }));

    const inSheet = within(within(sheet).getByRole('tabpanel')).getByText('No description.');
    expect(onPage).toBeDefined();
    expect(inSheet.className).toBe(onPage?.className);
  });
});

describe('task edit sheet: grooming', () => {
  it('offers no Grooming once the task has started', async () => {
    const sheet = await openSheet(todo({ lifecycle: 'in_progress', status: 'in_progress' }));

    expect(within(sheet).queryByRole('radiogroup', { name: 'Grooming' })).toBeNull();
    expect(within(sheet).getByRole('radiogroup', { name: 'Size' })).toBeVisible();
  });

  it('sets a grooming state with no note', async () => {
    const sheet = await openSheet(todo());
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Groomed' }));
    expect(within(sheet).queryByRole('textbox', { name: /Open questions/ })).toBeNull();
    await save(sheet);

    await waitFor(() => {
      expect(sent(groom)).toStrictEqual([{ ids: ['MMR-417'], state: 'groomed' }]);
    });
  });

  it('asks for the open questions on Needs answers, holding Save until they are written, and sends them as the note', async () => {
    const sheet = await openSheet(todo());
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Needs answers' }));
    const questions = within(sheet).getByRole('textbox', { name: /Open questions/ });
    expect(questions).toHaveAccessibleDescription(
      'Required for Needs answers. Saved as a note on the task.',
    );
    const commit = within(sheet).getByRole('button', { name: 'Save' });
    expect(commit).toBeDisabled();
    await userEvent.type(questions, '   ');
    expect(commit).toBeDisabled();
    await userEvent.type(questions, 'Which store wins?');
    expect(commit).toBeEnabled();
    await save(sheet);

    await waitFor(() => {
      expect(sent(groom)).toStrictEqual([
        { ids: ['MMR-417'], note: 'Which store wins?', state: 'needs_answers' },
      ]);
    });
  });

  it('opens a task that already needs answers with no Open questions until grooming changes away and back', async () => {
    const sheet = await openSheet(todo({ grooming: 'needs_answers' }));
    const needs = within(sheet).getByRole('radio', { name: 'Needs answers' });
    expect(needs).toBeChecked();
    expect(within(sheet).queryByRole('textbox', { name: /Open questions/ })).toBeNull();

    await userEvent.click(within(sheet).getByRole('radio', { name: 'Groomed' }));
    await userEvent.click(needs);
    expect(within(sheet).getByRole('textbox', { name: /Open questions/ })).toBeVisible();
  });
});

describe('task edit sheet: a Save closes on the saved record', () => {
  it('reopens on the saved title, so changing it back is sent', async () => {
    stubViewport('desktop');
    const { sheet, release } = await openHeldSheet(todo());
    const title = within(sheet).getByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'First save');
    await saveThroughRefetch(sheet, release);

    const again = await openEdit();
    const reopened = within(again).getByRole('textbox', { name: 'Title' });
    expect(reopened).toHaveValue('First save');
    await userEvent.clear(reopened);
    await userEvent.type(reopened, 'Add the SQLite dialect');
    await save(again);

    await waitFor(() => {
      expect(sent(update).at(-1)).toStrictEqual({ id: 'MMR-417', title: 'Add the SQLite dialect' });
    });
  });

  it('reopens on the saved description, so a further edit builds on it', async () => {
    stubViewport('desktop');
    const { sheet, release } = await openHeldSheet(todo());
    const description = within(sheet).getByRole('textbox', { name: /Description/ });
    await userEvent.clear(description);
    await userEvent.type(description, 'New prose.');
    await saveThroughRefetch(sheet, release);

    const again = await openEdit();
    await userEvent.type(within(again).getByRole('textbox', { name: /Description/ }), ' More.');
    await save(again);

    await waitFor(() => {
      expect(sent(update).at(-1)).toStrictEqual({ description: 'New prose. More.', id: 'MMR-417' });
    });
  });
});

describe('task edit sheet: a Save that partly fails', () => {
  it('stays open on the failed field, names what saved, reads Close, and sends only what failed again', async () => {
    stubViewport('desktop');
    const sheet = await openSheet(todo({ size: 'small' }));
    vi.mocked(move).mockRejectedValueOnce(new Error("the host didn't answer"));
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Medium' }));
    await userEvent.click(within(sheet).getByRole('button', { name: /^Parent/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Console/ }));
    await save(sheet);

    const parent = await within(sheet).findByRole('button', { name: /^Parent/ });
    expect(parent).toHaveAccessibleDescription(
      "Not moved: the host didn't answer. Save again to move it.",
    );
    expect(parent).toHaveAttribute('aria-invalid', 'true');
    expect(within(sheet).getByText("Size saved. The move didn't.")).toBeVisible();
    const footer = sheet.querySelector<HTMLElement>('[data-slot="form-sheet-footer"]')!;
    expect(within(footer).getByRole('button', { name: 'Close' })).toBeVisible();
    expect(within(footer).queryByRole('button', { name: 'Cancel' })).toBeNull();

    vi.mocked(update).mockClear();
    vi.mocked(move).mockClear();
    await save(sheet);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
    });
    expect(sent(move)).toStrictEqual([{ id: 'MMR-417', to: 'MMR-3' }]);
    expect(update).not.toHaveBeenCalled();
  });

  it("clears a failed field's error once its value changes, and keeps the others", async () => {
    stubViewport('desktop');
    const sheet = await openSheet(todo({ size: 'small' }));
    vi.mocked(move).mockRejectedValueOnce(new Error("the host didn't answer"));
    vi.mocked(update).mockRejectedValueOnce(new Error("the host didn't answer"));
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Medium' }));
    await userEvent.click(within(sheet).getByRole('button', { name: /^Parent/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Console/ }));
    await save(sheet);
    const parent = await within(sheet).findByRole('button', { name: /^Parent/ });
    await waitFor(() => {
      expect(parent).toHaveAttribute('aria-invalid', 'true');
    });

    await userEvent.click(parent);
    await userEvent.click(await screen.findByRole('option', { name: /SQLite/ }));

    expect(within(sheet).getByRole('button', { name: /^Parent/ })).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(within(sheet).getByRole('radiogroup', { name: 'Size' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('keeps Close after a later Save that saved nothing', async () => {
    stubViewport('desktop');
    const sheet = await openSheet(todo({ size: 'small' }));
    vi.mocked(move)
      .mockRejectedValueOnce(new Error("the host didn't answer"))
      .mockRejectedValueOnce(new Error("the host didn't answer"));
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Medium' }));
    await userEvent.click(within(sheet).getByRole('button', { name: /^Parent/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Console/ }));
    await save(sheet);
    await within(sheet).findByText("Size saved. The move didn't.");

    await save(sheet);
    await within(sheet).findByText('Nothing saved.');
    const footer = sheet.querySelector<HTMLElement>('[data-slot="form-sheet-footer"]')!;
    expect(within(footer).getByRole('button', { name: 'Close' })).toBeVisible();
  });

  it('sends a saved Needs answers and its note once, when another write failed beside it', async () => {
    const sheet = await openSheet(todo());
    vi.mocked(move).mockRejectedValueOnce(new Error("the host didn't answer"));
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Needs answers' }));
    await userEvent.type(within(sheet).getByRole('textbox', { name: /Open questions/ }), 'Which?');
    await userEvent.click(within(sheet).getByRole('button', { name: /^Parent/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Console/ }));
    await save(sheet);
    await within(sheet).findByText("Grooming saved. The move didn't.");
    expect(within(sheet).queryByRole('textbox', { name: /Open questions/ })).toBeNull();

    vi.mocked(groom).mockClear();
    await save(sheet);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
    });
    expect(groom).not.toHaveBeenCalled();
  });

  it('sends its writes one after another, each after the last settles, and still tries every one', async () => {
    const sheet = await openSheet(todo());
    const pending = Promise.withResolvers<never>();
    vi.mocked(update).mockReturnValueOnce(pending.promise);
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Title' }), '!');
    await userEvent.click(sheet.querySelector('[aria-label="Remove ui"]')!);
    await userEvent.click(within(sheet).getByRole('button', { name: /^Parent/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Console/ }));
    await save(sheet);

    await waitFor(() => {
      expect(update).toHaveBeenCalledOnce();
    });
    expect(untag).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    pending.reject(new Error("the host didn't answer"));
    await within(sheet).findByText("Tags and the move saved. The title didn't.");
    expect(sent(untag)).toStrictEqual([{ ids: ['MMR-417'], tags: ['ui'] }]);
    expect(sent(move)).toStrictEqual([{ id: 'MMR-417', to: 'MMR-3' }]);
  });

  it('raises no toast beside the error it shows on the field', async () => {
    const sheet = await openSheet(todo());
    vi.mocked(update).mockRejectedValueOnce(new Error("the host didn't answer"));
    vi.mocked(untag).mockRejectedValueOnce(new Error("the host didn't answer"));
    vi.mocked(move).mockRejectedValueOnce(new Error("the host didn't answer"));
    vi.mocked(groom).mockRejectedValueOnce(new Error("the host didn't answer"));
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Title' }), '!');
    await userEvent.click(sheet.querySelector('[aria-label="Remove ui"]')!);
    await userEvent.click(within(sheet).getByRole('button', { name: /^Parent/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Console/ }));
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Groomed' }));
    await save(sheet);

    await within(sheet).findByText('Nothing saved.');
    expect(toast.error).not.toHaveBeenCalled();
  });
});
