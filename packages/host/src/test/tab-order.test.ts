import { afterEach, describe, expect, it } from 'vitest';

import { tabNeighbour, tabSequence } from '../components/patterns/feed/tab-order';

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function labels(elements: HTMLElement[]): string[] {
  return elements.map((element) => element.textContent ?? '');
}

afterEach(() => {
  document.body.replaceChildren();
});

/** Marks each element `editable` as Chromium reports it: `isContentEditable`, which jsdom lacks. */
function editable(...elements: Element[]) {
  for (const element of elements) {
    Object.defineProperty(element, 'isContentEditable', { configurable: true, value: true });
  }
}

/** The radios in `root`'s sequence, by value, Tab's way or Shift+Tab's. */
function radios(root: HTMLElement, backward = false): string[] {
  return tabSequence(root, { backward }).map((element) =>
    element instanceof HTMLInputElement ? element.value : (element.textContent ?? ''),
  );
}

describe('tabSequence', () => {
  it('leaves out a disabled control even when it carries tabindex="0"', () => {
    const root = mount(
      '<button>Open</button><button disabled tabindex="0">Pending</button><button>Next</button>',
    );
    expect(labels(tabSequence(root))).toEqual(['Open', 'Next']);
  });

  it('leaves out a control that visibility:hidden takes off the page', () => {
    const root = mount(
      '<button>Open</button><button style="visibility:hidden">Hidden</button><button>Next</button>',
    );
    const hidden = root.querySelectorAll('button')[1]!;
    // jsdom lays nothing out, so tell checkVisibility what Chromium reports for
    // visibility:hidden once the visibilityProperty option is asked for.
    Object.defineProperty(hidden, 'checkVisibility', {
      configurable: true,
      value: (options?: { visibilityProperty?: boolean }) => options?.visibilityProperty !== true,
    });
    expect(labels(tabSequence(root))).toEqual(['Open', 'Next']);
  });

  it('visits positive tabindex values first, in ascending order, then the rest in document order', () => {
    const root = mount(
      '<button>Zero A</button><button tabindex="2">Two</button><button tabindex="1">One</button><button>Zero B</button>',
    );
    expect(labels(tabSequence(root))).toEqual(['One', 'Two', 'Zero A', 'Zero B']);
  });
});

describe('tabSequence: editing hosts', () => {
  it('counts an editing host without tabindex, and nothing inside it', () => {
    const root = mount(
      '<button>Open</button><div contenteditable>Note <b contenteditable="true">bold</b> <span tabindex="0">x</span></div><button>Next</button>',
    );
    const host = root.querySelector('div')!;
    editable(host, ...host.querySelectorAll('*'));
    expect(tabSequence(root)).toEqual([
      root.querySelectorAll('button')[0],
      host,
      root.querySelectorAll('button')[1],
    ]);
  });

  it('leaves out an element whose contenteditable is false', () => {
    const root = mount('<button>Open</button><div contenteditable="false">Read only</div>');
    expect(labels(tabSequence(root))).toEqual(['Open']);
  });
});

/** Radios a, b, and c named `size`, `checked` among them when given, then a button. */
const group = (checked?: string) =>
  mount(
    `${['a', 'b', 'c']
      .map(
        (value) =>
          `<input type="radio" name="size" value="${value}"${value === checked ? ' checked' : ''}>`,
      )
      .join('')}<button>After</button>`,
  );

describe('tabSequence: radio groups', () => {
  it('stops once, on the checked radio, both ways', () => {
    const root = group('b');
    expect(radios(root)).toEqual(['b', 'After']);
    expect(radios(root, true)).toEqual(['b', 'After']);
  });

  it('with none checked, stops on the first radio for Tab and the last for Shift+Tab', () => {
    const root = group();
    expect(radios(root)).toEqual(['a', 'After']);
    expect(radios(root, true)).toEqual(['c', 'After']);
  });

  it('keeps radios with another name, or in another form, as their own groups', () => {
    const root = mount(
      '<input type="radio" name="size" value="a"><input type="radio" name="kind" value="b">' +
        '<form><input type="radio" name="size" value="c"></form><input type="radio" value="d"><input type="radio" value="e">',
    );
    expect(radios(root)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('tabNeighbour', () => {
  it('reaches a radio group at its checked radio, and leaves it from there', () => {
    const root = mount(
      '<button>Open</button><input type="radio" name="size" value="a"><input type="radio" name="size" value="b" checked><button>Next</button>',
    );
    const [open, next] = root.querySelectorAll('button');
    const checked = root.querySelector<HTMLElement>('input:checked')!;
    expect(tabNeighbour({ from: open!, skip: null })).toBe(checked);
    expect(tabNeighbour({ backward: true, from: next!, skip: null })).toBe(checked);
    expect(tabNeighbour({ from: checked, skip: null })).toBe(next);
  });

  it('leaves an unchecked group from the radio that has focus, either way', () => {
    const root = mount(
      '<button>Open</button><input type="radio" name="size" value="a"><input type="radio" name="size" value="b"><button>Next</button>',
    );
    const [open, next] = root.querySelectorAll('button');
    const [first, last] = root.querySelectorAll('input');
    expect(tabNeighbour({ from: open!, skip: null })).toBe(first);
    expect(tabNeighbour({ backward: true, from: next!, skip: null })).toBe(last);
    expect(tabNeighbour({ backward: true, from: first!, skip: null })).toBe(open);
    expect(tabNeighbour({ from: last!, skip: null })).toBe(next);
  });

  it('steps from a card past a disabled control to the next one Tab reaches', () => {
    const root = mount(
      '<button>Open</button><button disabled tabindex="0">Pending</button><button>Next</button>',
    );
    const [open] = root.querySelectorAll('button');
    expect(tabNeighbour({ from: open!, skip: null })?.textContent).toBe('Next');
  });
});
