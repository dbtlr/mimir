import { describe, expect, it } from 'vitest';

import { isExternalHref, splitLinks } from '../lib/links';

describe('splitLinks', () => {
  it('returns plain text as one text segment', () => {
    expect(splitLinks('nothing to see')).toEqual([{ kind: 'text', value: 'nothing to see' }]);
  });

  it('returns no segments for empty text', () => {
    expect(splitLinks('')).toEqual([]);
  });

  it('splits one URL out of a sentence, keeping the text around it exact', () => {
    expect(splitLinks('Pick a variant from https://muninn.bifrost.lol/a/eHHTAO7KRz now')).toEqual([
      { kind: 'text', value: 'Pick a variant from ' },
      { kind: 'url', value: 'https://muninn.bifrost.lol/a/eHHTAO7KRz' },
      { kind: 'text', value: ' now' },
    ]);
  });

  it.each([
    ['See https://example.com/a.', 'https://example.com/a', '.'],
    ['(see https://example.com/a)', 'https://example.com/a', ')'],
    ['Try https://example.com/a, then stop', 'https://example.com/a', ', then stop'],
    ['Read https://example.com/a; done', 'https://example.com/a', '; done'],
    ['Read https://example.com/a: done', 'https://example.com/a', ': done'],
    ['Really https://example.com/a?!', 'https://example.com/a', '?!'],
  ])('leaves trailing punctuation out of the URL in %j', (text, url, tail) => {
    const segments = splitLinks(text);
    expect(segments).toContainEqual({ kind: 'url', value: url });
    expect(segments.at(-1)).toEqual({ kind: 'text', value: tail });
  });

  it('keeps a closing paren that balances one inside the URL', () => {
    expect(splitLinks('https://en.wikipedia.org/wiki/Foo_(bar).')).toEqual([
      { kind: 'url', value: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { kind: 'text', value: '.' },
    ]);
  });

  it('finds every URL', () => {
    const urls = splitLinks('http://a.test/x and https://b.test/y.').filter(
      (s) => s.kind === 'url',
    );
    expect(urls.map((s) => s.value)).toEqual(['http://a.test/x', 'https://b.test/y']);
  });

  it('does not match http without a URL', () => {
    expect(splitLinks('http is a protocol; so is https://.')).toEqual([
      { kind: 'text', value: 'http is a protocol; so is https://.' },
    ]);
  });
});

describe('isExternalHref', () => {
  it.each(['https://example.com', 'http://example.com/a', 'HTTPS://EXAMPLE.COM'])(
    'treats %s as external',
    (href) => {
      expect(isExternalHref(href)).toBe(true);
    },
  );

  it.each(['/p/MMR/1', '#section', 'relative/path', 'mailto:a@b.test', '', undefined])(
    'leaves %j to default behavior',
    (href) => {
      expect(isExternalHref(href)).toBe(false);
    },
  );
});
