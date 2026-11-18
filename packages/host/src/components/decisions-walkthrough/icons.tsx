import type { ComponentProps } from 'react';

/*
 * The walkthrough's few glyphs, drawn in `currentColor` on a 16px grid. They
 * are decoration: the words beside them carry the meaning.
 */
function Glyph({ size = 14, children, ...props }: ComponentProps<'svg'> & { size?: number }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      {...props}
    >
      {children}
    </svg>
  );
}

export function CheckGlyph({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M3.5 8.5l3 3 6-7" />
    </Glyph>
  );
}

export function BackGlyph({ size }: { size?: number }) {
  return (
    <Glyph size={size ?? 16}>
      <path d="M13 8H3.5M7.5 4L3.5 8l4 4" />
    </Glyph>
  );
}

/** The agent's mark: a diamond with a point at its centre. */
export function AgentGlyph({ size }: { size?: number }) {
  return (
    <Glyph size={size} strokeWidth="1.4">
      <path d="M8 2.2l5.8 5.8L8 13.8 2.2 8z" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function SendGlyph({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M2.5 8l11-5-3.5 10-2.5-4z" />
    </Glyph>
  );
}
