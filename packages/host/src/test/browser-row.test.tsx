import { screen } from '@testing-library/react';
import { describe, expect } from 'vitest';

import { BrowserRow } from '../components/browser-list';
import { nodeLink } from '../lib/record-url';
import { renderInRouter } from './router';

const LONG_TITLE =
  'A deliberately long task title that will wrap onto a second and third line in a narrow column';

async function renderRow() {
  await renderInRouter(
    <BrowserRow
      to={nodeLink('MMR-417')}
      id="MMR-417"
      title={LONG_TITLE}
      beforeTitle={<span>before-chip</span>}
      afterTitle={<span>after-chip</span>}
      lede="a one-line lede"
      meta={<span>meta-line</span>}
    />,
  );
  return {
    after: screen.getByText('after-chip'),
    before: screen.getByText('before-chip'),
    id: screen.getByText('MMR-417'),
    lede: screen.getByText('a one-line lede'),
    meta: screen.getByText('meta-line'),
    title: screen.getByRole('link', { name: LONG_TITLE }),
  };
}

describe('browserRow layout (MMR-488)', () => {
  it('keeps the id in its own column, apart from the title and its chips', async () => {
    const { id, title, before, after } = await renderRow();
    const titleColumn = title.parentElement as HTMLElement;

    // The id is a sibling column of the title column, not a member of it.
    expect(id.parentElement).toBe(titleColumn.parentElement);
    expect(titleColumn).not.toContainElement(id);
    // Chips on either side of the title live in the title column, so when the
    // title wraps they wrap within it instead of dropping under the id.
    expect(titleColumn).toContainElement(before);
    expect(titleColumn).toContainElement(after);
  });

  it('places the lede and meta line in the id’s grid, outside the title column', async () => {
    const { id, lede, meta } = await renderRow();
    const metaLine = meta.parentElement as HTMLElement;

    // Lede and meta share the id's grid, so they sit beside it, not inside the title column.
    expect(lede.parentElement).toBe(id.parentElement);
    expect(metaLine.parentElement).toBe(id.parentElement);
  });
});
