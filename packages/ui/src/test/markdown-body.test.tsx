import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarkdownBody } from '../components/markdown-body';

const SPECIMEN = [
  '# Title',
  '## Section',
  '### Subsection',
  '#### Detail',
  '',
  'A paragraph with **bold**, *italic*, `inline`, and [a link](https://example.com).',
  '',
  '- bullet one',
  '  - nested bullet',
  '- [x] done task',
  '- [ ] open task',
  '',
  '1. first',
  '2. second',
  '',
  '> quoted text',
  '',
  '---',
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
  it('renders every markdown element type as its semantic element, headings demoted below h2', () => {
    render(<MarkdownBody>{SPECIMEN}</MarkdownBody>);
    const article = screen.getByRole('article');

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(
      within(article)
        .getAllByRole('heading')
        .map((h) => h.tagName),
    ).toEqual(['H3', 'H4', 'H5', 'H6']);
    expect(within(article).getByText('bold').tagName).toBe('STRONG');
    expect(within(article).getByText('italic').tagName).toBe('EM');
    expect(within(article).getByRole('link', { name: 'a link' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    expect(article.querySelectorAll('ul')).toHaveLength(2);
    expect(article.querySelectorAll('ol li')).toHaveLength(2);
    expect(within(article).getAllByRole('checkbox')).toHaveLength(2);
    expect(article.querySelector('blockquote')).toHaveTextContent('quoted text');
    expect(article.querySelector('hr')).not.toBeNull();
    expect(within(article).getByRole('table')).toBeInTheDocument();
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

  it('loads the image when the host opts in with `images`', () => {
    render(<MarkdownBody images>![build graph](https://example.com/graph.png)</MarkdownBody>);

    expect(screen.getByRole('img', { name: 'build graph' }).getAttribute('src')).toBe(
      'https://example.com/graph.png',
    );
  });
});
