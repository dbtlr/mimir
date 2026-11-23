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

describe('tabNeighbour', () => {
  it('steps from a card past a disabled control to the next one Tab reaches', () => {
    const root = mount(
      '<button>Open</button><button disabled tabindex="0">Pending</button><button>Next</button>',
    );
    const [open] = root.querySelectorAll('button');
    expect(tabNeighbour({ from: open!, skip: null })?.textContent).toBe('Next');
  });
});
