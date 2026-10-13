import { describe, expect, it } from 'vitest';

import { isBareUrl, isExternalHref, splitLinks } from '../lib/links';

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

/** The URLs `splitLinks` found in `text`. */
const urlsIn = (text: string): string[] =>
  splitLinks(text)
    .filter((segment) => segment.kind === 'url')
    .map((segment) => segment.value);

describe('splitLinks trailing trim', () => {
  it.each([
    ['`https://x.test/a`', 'https://x.test/a'],
    ['**https://x.test/a**', 'https://x.test/a'],
    ['_https://x.test/a_', 'https://x.test/a'],
    ['<https://x.test/a>', 'https://x.test/a'],
    ["'https://x.test/a'", 'https://x.test/a'],
    ['"https://x.test/a"', 'https://x.test/a'],
    ['https://x.test/a。', 'https://x.test/a'],
    ['https://x.test/a，', 'https://x.test/a'],
    ['https://x.test/a、', 'https://x.test/a'],
    ['https://x.test/a；', 'https://x.test/a'],
    ['https://x.test/a：', 'https://x.test/a'],
    ['https://x.test/a！', 'https://x.test/a'],
    ['https://x.test/a？', 'https://x.test/a'],
  ])('links %s as %s', (text, href) => {
    expect(urlsIn(text)).toEqual([href]);
  });

  it('stops the URL at a zero-width space', () => {
    expect(urlsIn('https://x.test/a​b')).toEqual(['https://x.test/a']);
  });

  it('stops the URL at other whitespace', () => {
    expect(urlsIn('https://x.test/a b')).toEqual(['https://x.test/a']);
  });

  it('keeps the text around the URL so segments rejoin to the input', () => {
    const text = 'see **https://x.test/a**, ok';
    expect(
      splitLinks(text)
        .map((segment) => segment.value)
        .join(''),
    ).toBe(text);
  });
});

describe('splitLinks bracket balance', () => {
  it('keeps the ] of an IPv6 host', () => {
    expect(urlsIn('http://[::1]')).toEqual(['http://[::1]']);
  });

  it('drops a trailing ] the URL never opened', () => {
    expect(urlsIn('[see https://x.test]')).toEqual(['https://x.test']);
  });

  it('keeps a balanced ) and drops an unopened one', () => {
    expect(urlsIn('https://x.test/Foo_(bar)')).toEqual(['https://x.test/Foo_(bar)']);
    expect(urlsIn('(see https://x.test/a)')).toEqual(['https://x.test/a']);
  });
});

describe('splitLinks on long input', () => {
  it('trims a long run of closing parens in linear time', () => {
    const text = `https://a${')'.repeat(100_000)}`;
    const start = performance.now();
    const urls = urlsIn(text);
    expect(performance.now() - start).toBeLessThan(250);
    expect(urls).toEqual(['https://a']);
  });
});

describe('isExternalHref', () => {
  it('treats a protocol-relative //host as external', () => {
    expect(isExternalHref('//evil.test')).toBe(true);
  });

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

describe('isBareUrl', () => {
  it('accepts a value that is one whole http(s) URL', () => {
    expect(isBareUrl('https://github.com/dbtlr/mimir/pull/424')).toBe(true);
  });

  it('refuses free text that merely starts with a URL', () => {
    expect(isBareUrl('https://x.test PR')).toBe(false);
    expect(isBareUrl('https://x.test.')).toBe(false);
  });

  it('refuses ids and protocol-relative references', () => {
    expect(isBareUrl('JIRA-123')).toBe(false);
    expect(isBareUrl('//evil.test')).toBe(false);
  });
});
