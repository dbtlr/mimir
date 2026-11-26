import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownBody } from '../components/markdown-body';

const SPECIMEN = [
  '# Title',
  '## Section',
  '### Subsection',
  '#### Detail',
  '',
  'A paragraph with `inline` code.',
  '',
  '| head | other |',
  '| ---- | ----- |',
  '| cell | value |',
  '',
  '```ts',
  'const fenced = 1;',
  '```',
].join('\n');

describe('markdownBody', () => {
  it('demotes headings below h2, renders a table through its scrolling wrapper, and sets inline code apart from a fenced block', () => {
    render(<MarkdownBody>{SPECIMEN}</MarkdownBody>);
    const article = screen.getByRole('article');

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(
      within(article)
        .getAllByRole('heading')
        .map((h) => h.tagName),
    ).toEqual(['H3', 'H4', 'H5', 'H6']);
    expect(within(article).getByRole('table')).toBeInTheDocument();
    expect(within(article).getByRole('table').closest('[data-md="table"]')).not.toBeNull();
    expect(within(article).getByRole('columnheader', { name: 'head' })).toBeInTheDocument();
    expect(article.querySelector('pre > code')).toHaveTextContent('const fenced = 1;');
    const inline = within(article).getByText('inline');
    expect(inline.tagName).toBe('CODE');
    expect(inline.closest('pre')).toBeNull();
  });

  it('joins single newlines into one paragraph by default, as standard markdown does', () => {
    render(<MarkdownBody>{'Status: done\nTests: pass'}</MarkdownBody>);
    const article = screen.getByRole('article');

    expect(article.querySelectorAll('p')).toHaveLength(1);
    expect(article.querySelector('br')).toBeNull();
  });

  it('keeps single newlines as line breaks when `breaks` is set', () => {
    render(<MarkdownBody breaks>{'Status: done\nTests: pass'}</MarkdownBody>);
    const article = screen.getByRole('article');

    expect(article.querySelectorAll('p')).toHaveLength(1);
    expect(article.querySelectorAll('br')).toHaveLength(1);
  });

  it('renders an image as a link to it, fetching nothing, by default', () => {
    render(<MarkdownBody>![build graph](https://tracker.example/pixel.png)</MarkdownBody>);
    const article = screen.getByRole('article');

    expect(article.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: /build graph/ }).getAttribute('href')).toBe(
      'https://tracker.example/pixel.png',
    );
  });

  it('opens an external image link in a new tab and leaves a relative one alone', () => {
    render(
      <MarkdownBody>![remote](https://example.com/a.png) ![local](/files/a.png)</MarkdownBody>,
    );

    const remote = screen.getByRole('link', { name: /remote/ });
    expect(remote.getAttribute('target')).toBe('_blank');
    expect(remote.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: /local/ }).hasAttribute('target')).toBe(false);
  });

  it('re-measures a clamped body when its width changes', () => {
    const observed: { resize?: () => void } = {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(onResize: () => void) {
          observed.resize = onResize;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    let scrollHeight = 60;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => scrollHeight);
    const onClampMeasure = vi.fn();
    render(
      <MarkdownBody clamp={3} onClampMeasure={onClampMeasure}>
        a note that fits until the window narrows
      </MarkdownBody>,
    );
    expect(onClampMeasure).toHaveBeenLastCalledWith(
      expect.objectContaining({ overflowing: false }),
    );

    scrollHeight = 120;
    act(() => observed.resize?.());

    expect(onClampMeasure).toHaveBeenLastCalledWith(expect.objectContaining({ overflowing: true }));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a note of fewer than 12 lines whole, even when its block spacing runs past 12 lines’ height', () => {
    // Eleven one-line bullets, each line box 20 tall and 30 apart: 330 of
    // content against a 240 clamp, yet only 11 lines of text.
    const real = globalThis.getComputedStyle.bind(globalThis);
    vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el.tagName === 'ARTICLE' ? ({ lineHeight: '20px' } as CSSStyleDeclaration) : real(el, pseudo),
    );
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(330);
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        const line = Number(/\d+/.exec(this.startContainer.textContent ?? '')?.[0]);
        return [DOMRect.fromRect({ height: 20, width: 40, y: (line - 1) * 30 })];
      },
    });
    const onClampMeasure = vi.fn();
    try {
      render(
        <MarkdownBody breaks clamp={12} onClampMeasure={onClampMeasure}>
          {Array.from({ length: 11 }, (_, i) => `- item ${String(i + 1)}`).join('\n')}
        </MarkdownBody>,
      );

      expect(onClampMeasure).toHaveBeenLastCalledWith({ lines: 11, overflowing: false });
      const article = screen.getByRole('article');
      expect(article).not.toHaveAttribute('data-overflowing');
      expect(article.style.getPropertyValue('--clamp-height')).toBe('none');
    } finally {
      Reflect.deleteProperty(Range.prototype, 'getClientRects');
      vi.restoreAllMocks();
    }
  });

  it('clips a code block and a table in the 3-line preview, so neither scrolls nor takes focus, while a full body scrolls them', () => {
    const { unmount } = render(<MarkdownBody clamp={3}>{SPECIMEN}</MarkdownBody>);
    const preview = screen.getByRole('article');
    const previewTable = within(preview).getByRole('table').closest('[data-md="table"]');
    expect(preview).toHaveClass('prose-pre:overflow-hidden');
    expect(preview).not.toHaveClass('prose-pre:overflow-x-auto');
    expect(previewTable).toHaveClass('overflow-hidden');
    expect(previewTable).not.toHaveClass('overflow-x-auto');
    unmount();

    render(<MarkdownBody clamp={12}>{SPECIMEN}</MarkdownBody>);
    const fold = screen.getByRole('article');
    expect(fold).toHaveClass('prose-pre:overflow-x-auto');
    expect(within(fold).getByRole('table').closest('[data-md="table"]')).toHaveClass(
      'overflow-x-auto',
    );
  });

  it('loads the image when the host opts in with `images`', () => {
    render(<MarkdownBody images>![build graph](https://example.com/graph.png)</MarkdownBody>);

    expect(screen.getByRole('img', { name: 'build graph' }).getAttribute('src')).toBe(
      'https://example.com/graph.png',
    );
  });

  it('opens an external link in a new tab, in a document body too, and leaves in-app, anchor, and mailto links alone', () => {
    const body = [
      'See [the docs](https://example.com/docs) or https://example.org/x.',
      '[task](/p/MMR/1) [top](#top) [mail](mailto:drew@example.com)',
    ].join('\n\n');

    for (const images of [false, true]) {
      const { unmount } = render(<MarkdownBody images={images}>{body}</MarkdownBody>);
      for (const name of ['the docs', 'https://example.org/x']) {
        const link = screen.getByRole('link', { name });
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      }
      for (const name of ['task', 'top', 'mail']) {
        const link = screen.getByRole('link', { name });
        expect(link.hasAttribute('target')).toBe(false);
        expect(link.hasAttribute('rel')).toBe(false);
      }
      unmount();
    }
  });
});
