import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';
import type { artifactLink, nodeLink, seedLink } from '../lib/record-url';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from './ui/menu';

/**
 * The grouped reading list (MMR-448 mock "Browsers C", MMR-454) — the shared
 * anatomy of the `/tasks`, `/artifacts`, and `/seeds` browsers: one centred
 * column, a header with a count, a row of filter chips, and rows grouped under
 * a microlabel. Every row is a real link to its record's page.
 */

/** The centred column with the page header: title, a faint count, and an optional action. */
export function BrowserPage({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[900px] px-4 pt-4 pb-8 md:px-5">
      <header className="mb-3 flex flex-wrap items-center gap-2.5">
        <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">{title}</h1>
        {count !== undefined && <span className="text-meta text-ink-faint">{count}</span>}
        {action !== undefined && <div className="ml-auto">{action}</div>}
      </header>
      {children}
    </div>
  );
}

/** The filter row: a search box that takes the free width, then the chips. */
export function FilterRow({ children }: { children: ReactNode }) {
  return <div className="mb-2.5 flex flex-wrap items-center gap-1.5">{children}</div>;
}

/** The browser search box — controlled; debouncing is the caller's concern. */
export function BrowserSearch({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
}) {
  return (
    <label className="flex min-w-0 flex-[1_1_260px] items-center gap-2 rounded-[9px] border border-line-bright bg-well-950 px-2.5 py-1.5 transition-colors focus-within:border-accent">
      <span aria-hidden className="text-ink-faint">
        ⌕
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        aria-label={label}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-meta text-ink-bright caret-accent outline-none placeholder:text-ink-faint"
      />
    </label>
  );
}

const CHIP =
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs whitespace-nowrap inset-ring transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
const CHIP_OFF = 'text-ink-dim inset-ring-line-bright hover:text-ink';
const CHIP_ON = 'bg-accent/10 text-accent-foreground inset-ring-accent/28';

/** A toggle chip (`Live`, `Finished`) — pressed state is the accent wash. */
export function FilterChip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
    >
      {children}
    </button>
  );
}

/**
 * A filter the URL carries but no chip offers (a deep-linked status, a date
 * window): shown in the accent wash with ✕, and clicking removes it.
 */
export function RemovableChip({
  label,
  removeLabel,
  onRemove,
}: {
  label: string;
  /** Accessible name — names the filter, e.g. "Remove status filter Ready". */
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={removeLabel}
      onClick={onRemove}
      className={cn(CHIP, CHIP_ON, 'hover:bg-accent/15')}
    >
      <span className="max-w-40 truncate">{label}</span>
      <span aria-hidden>✕</span>
    </button>
  );
}

export type MenuChipOption = { value: string; label: ReactNode };

/**
 * A chip that opens a menu of options (`All projects ▾`, `Any kind ▾`,
 * `Group: status ▾`). It reads as `on` whenever a non-default value is chosen.
 */
export function MenuChip({
  label,
  on,
  options,
  onSelect,
}: {
  label: ReactNode;
  on: boolean;
  options: readonly MenuChipOption[];
  onSelect: (value: string) => void;
}) {
  return (
    <MenuRoot>
      <MenuTrigger className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}>
        {label}
        <span aria-hidden>▾</span>
      </MenuTrigger>
      <MenuContent className="max-h-80 w-56 overflow-y-auto">
        {options.map((o) => (
          <MenuItem
            key={o.value}
            onClick={() => {
              onSelect(o.value);
            }}
          >
            {o.label}
          </MenuItem>
        ))}
      </MenuContent>
    </MenuRoot>
  );
}

/** The mono uppercase microlabel every group header and fold uses. */
const MICROLABEL = 'font-mono text-micro font-semibold tracking-[0.13em] uppercase';

/**
 * One group: a microlabel header (`In progress · 2`, `Today`) over its rows.
 * `labelClassName` carries a lane colour; the default is the faint ink tier.
 */
export function BrowserGroup({
  label,
  count,
  labelClassName,
  children,
}: {
  label: string;
  count?: number;
  labelClassName?: string;
  children?: ReactNode;
}) {
  const heading = count === undefined ? label : `${label} · ${count}`;
  return (
    <section aria-label={heading} className="mt-4">
      <h2
        className={cn(
          'mb-2 block border-b border-line pb-1.5',
          MICROLABEL,
          labelClassName ?? 'text-ink-faint',
        )}
      >
        {heading}
      </h2>
      {children}
    </section>
  );
}

type RecordTarget =
  | ReturnType<typeof nodeLink>
  | ReturnType<typeof seedLink>
  | ReturnType<typeof artifactLink>;

/**
 * One row of a browser: an optional leading mark (a status dot), then the id
 * and title with optional chips before or after the title, a one-line lede,
 * and a meta line. The title link stretches over the whole row, so the row is
 * the hit target while staying a single real link. The lede hides on a phone
 * (the mock's "groups stay, ledes drop").
 */
export function BrowserRow({
  to,
  id,
  title,
  leading,
  beforeTitle,
  afterTitle,
  lede,
  meta,
  demoted = false,
  struck = false,
}: {
  to: RecordTarget;
  id: string;
  title: string;
  leading?: ReactNode;
  beforeTitle?: ReactNode;
  afterTitle?: ReactNode;
  lede?: string | null;
  meta?: ReactNode;
  /** Finished rows demote by ink tier, never by opacity (ADR 0019 §7). */
  demoted?: boolean;
  /** Strike the title through — an abandoned task. */
  struck?: boolean;
}) {
  return (
    <div className="relative flex gap-2.5 rounded-md px-1 py-[7px] transition-colors hover:bg-well-850 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-accent">
      {leading !== undefined && <span className="flex h-5 shrink-0 items-center">{leading}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-mono-id text-ink-faint">{id}</span>
          {beforeTitle}
          <Link
            {...to}
            className={cn(
              'min-w-0 text-body outline-none after:absolute after:inset-0',
              demoted ? 'text-ink-dim' : 'text-ink-bright',
              struck && 'line-through decoration-ink-ghost',
            )}
          >
            {title}
          </Link>
          {afterTitle}
        </div>
        {lede !== undefined && lede !== null && lede !== '' && (
          <p className="truncate text-[0.78125rem] text-ink-dim max-md:hidden">{lede}</p>
        )}
        {meta !== undefined && <div className="text-mono-id text-ink-faint">{meta}</div>}
      </div>
    </div>
  );
}

/** The empty state shared by all three browsers. */
export function BrowserEmpty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-10 text-center text-xs text-ink-faint">{children}</p>;
}
