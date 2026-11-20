import { act, fireEvent } from '@testing-library/react';
import { expect } from 'vitest';

/** jsdom keeps focus on a button when it disables, so blur it before the commit handler runs. */
export function pressAndDropFocus(button: HTMLElement) {
  act(() => {
    button.focus();
    expect(button).toHaveFocus();
    button.blur();
    expect(button.ownerDocument.body).toHaveFocus();
    fireEvent.click(button);
  });
}
