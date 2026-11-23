import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedCard } from '../components/patterns/feed/card';
import { FeedPreview } from '../components/patterns/feed/feed-preview';
import { PreviewRoomProvider } from '../components/patterns/feed/preview-room';
import { nodeLink } from '../lib/record-url';
import { ShellColumns } from '../routes/shell';
import { renderInRouter } from './router';
import { stubViewport } from './viewport';
import type { Viewport } from './viewport';

/*
 * The shell makes room for an open preview (ADR 0019, MMR-720 refinement):
 * from 1024 to 1599 the sidebar yields, from 1600 up it stays, and from `md`
 * up the content column re-centres beside the panel. The slide and the widths
 * are a real browser's to check; here the shell's state is read from the DOM.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderShellWithFeed(viewport: Viewport | number, sidebar = true) {
  stubViewport(viewport);
  return renderInRouter(
    <PreviewRoomProvider>
      <ShellColumns sidebar={sidebar ? <aside aria-label="Project">Sidebar</aside> : undefined}>
        <main>
          <FeedPreview
            preview={() => ({
              lead: <span>Ready</span>,
              open: nodeLink('MMR-1'),
              reason: 'Ready to start.',
              title: 'A task',
            })}
          >
            <FeedCard previewKey="MMR-1" lead={<span>Ready</span>} title="A task" />
          </FeedPreview>
        </main>
      </ShellColumns>
    </PreviewRoomProvider>,
  );
}

/** A feed of one task card, whose preview names the task. */
function taskFeed(id: string, title: string) {
  return (
    <FeedPreview
      preview={() => ({ lead: <span>Ready</span>, open: nodeLink(id), reason: 'Ready.', title })}
    >
      <FeedCard previewKey={id} lead={<span>Ready</span>} title={title} />
    </FeedPreview>
  );
}

const sidebarSlot = () => screen.getByRole('complementary', { hidden: true }).parentElement;
const content = () => screen.getByRole('main').parentElement;

describe('shell room for the preview panel', () => {
  it('lets the sidebar yield from 1024 to 1599 while a preview is open, and brings it back on close', async () => {
    await renderShellWithFeed('desktop');
    expect(sidebarSlot()).not.toHaveAttribute('inert');
    await userEvent.click(screen.getByRole('button', { name: 'A task' }));
    expect(sidebarSlot()).toHaveAttribute('inert');
    expect(sidebarSlot()).toHaveAttribute('data-yielded');
    expect(content()).toHaveAttribute('data-preview-room');
    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(sidebarSlot()).not.toHaveAttribute('inert');
    expect(content()).not.toHaveAttribute('data-preview-room');
  });

  it('keeps the sidebar from 1600 up, and re-centres the column beside the panel', async () => {
    await renderShellWithFeed('wide');
    await userEvent.click(screen.getByRole('button', { name: 'A task' }));
    expect(sidebarSlot()).not.toHaveAttribute('inert');
    expect(content()).toHaveAttribute('data-preview-room');
  });

  it('lets the sidebar yield up to 1599 and keeps it from 1600', async () => {
    await renderShellWithFeed(1599);
    await userEvent.click(screen.getByRole('button', { name: 'A task' }));
    expect(sidebarSlot()).toHaveAttribute('data-yielded');
    cleanup();
    vi.unstubAllGlobals();
    await renderShellWithFeed(1600);
    await userEvent.click(screen.getByRole('button', { name: 'A task' }));
    expect(sidebarSlot()).not.toHaveAttribute('data-yielded');
    expect(content()).toHaveAttribute('data-preview-room');
  });

  it('makes room from md with no sidebar column', async () => {
    await renderShellWithFeed('tablet', false);
    await userEvent.click(screen.getByRole('button', { name: 'A task' }));
    expect(content()).toHaveAttribute('data-preview-room');
  });

  it('keeps one preview a page: a card in a second feed closes the first feed’s panel, and the room stays until the last one closes', async () => {
    stubViewport('desktop');
    await renderInRouter(
      <PreviewRoomProvider>
        <ShellColumns sidebar={<aside aria-label="Project">Sidebar</aside>}>
          <main>
            {taskFeed('MMR-1', 'A task')}
            {taskFeed('MMR-2', 'Another task')}
          </main>
        </ShellColumns>
      </PreviewRoomProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'A task' }));
    await userEvent.click(screen.getByRole('button', { name: 'Another task' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Another task');
    expect(screen.getByRole('button', { name: 'A task' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(content()).toHaveAttribute('data-preview-room');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(content()).not.toHaveAttribute('data-preview-room');
  });

  it('makes no room on a phone, where the preview is a modal sheet', async () => {
    await renderShellWithFeed('phone', false);
    await userEvent.click(screen.getByRole('button', { name: 'A task' }));
    expect(content()).not.toHaveAttribute('data-preview-room');
  });
});
