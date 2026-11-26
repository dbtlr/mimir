/**
 * The sidebar's selection treatment (ADR 0019): the accent as a low-alpha
 * wash with a hairline inset ring, never a solid fill. Sections key it on any
 * `aria-current`, rows on `page`.
 */
export const SECTION_CURRENT =
  'aria-[current]:bg-accent/10 aria-[current]:text-ink-bright aria-[current]:inset-ring aria-[current]:inset-ring-accent/28';
export const ROW_CURRENT =
  'aria-[current=page]:bg-accent/10 aria-[current=page]:text-ink-bright aria-[current=page]:inset-ring aria-[current=page]:inset-ring-accent/28';
