/** The blocks a Form sheet's resting scroll lands on: fields, choice rows, and group headings. */
export const BLOCK_SELECTOR = '[data-form-block]';

/**
 * Marks an element as a block the Form sheet's body scroll rests on, 24 below
 * its header (DESIGN.md, Sheets): the end of a scroll and a move of focus land
 * there. Every field of a form wears it, including a Record picker's.
 */
export const BLOCK_PROPS = {
  className: 'scroll-mt-6',
  'data-form-block': '',
} as const;
