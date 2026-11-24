/**
 * The attribute that names a control focus returns to after a walkthrough or
 * the focus queue: an entry on a page, a bundle's button on the Needs you
 * page, or its Work through all (MMR-723). A plain constant, so a pattern can
 * put it on a control without importing the walkthrough's router hooks.
 */
export const RETURN_TARGET_ATTRIBUTE = 'data-walkthrough-return';
