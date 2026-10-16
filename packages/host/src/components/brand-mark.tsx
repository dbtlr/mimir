/**
 * The Mimir mark ("Board": three columns of cards, one selected) as an inline
 * glyph. It draws with Meridian tokens so it re-themes with the console; the
 * static icon files in `public/icons` carry the same geometry in fixed dark
 * values. Keep the two in step.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      className="shrink-0"
      data-testid="brand-mark"
    >
      <rect x="10" y="16" width="12" height="14" rx="2" className="fill-ink-dim" />
      <rect x="10" y="34" width="12" height="14" rx="2" className="fill-ink-dim" />
      <rect
        x="27.5"
        y="17.5"
        width="9"
        height="11"
        rx="1.5"
        strokeWidth="3"
        className="fill-accent/25 stroke-accent"
      />
      <rect x="26" y="34" width="12" height="14" rx="2" className="fill-ink-bright" />
      <rect x="42" y="16" width="12" height="14" rx="2" className="fill-ink-bright" />
    </svg>
  );
}
