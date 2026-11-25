import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import type { ReactNode, Ref } from 'react';

import { cn } from '../lib/cn';
import type { artifactLink, nodeLink, seedLink } from '../lib/record-url';
import { SearchIcon } from './ui/icons';

/**
 * The grouped reading list's parts (MMR-448 mock "Browsers C", MMR-454): a
 * group under a microlabel and a row that is a real link to its record's page,
 * which the work page and a delivery's tasks still list with; and the list
 * page's search box (MMR-724).
 */

/**
 * The list page's search box (MMR-724), controlled; debouncing is the
 * caller's concern. A 44-tall field on its own row, 15/22 text, an ink-dim
 * edge on the page ground, full width wherever the page's cards stack, and the
 * width of the card grid's first track where they sit two across, so it lines
 * up with the first column of cards.
 */
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
  // The card grid's columns follow its container's width, so the field reads the same container.
  return (
    <div className="@container w-full">
      <label className="flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-ink-dim bg-well-950 px-3 transition-colors focus-within:border-accent md:@min-[612px]:w-[calc((100%-0.75rem)/2)]">
        <SearchIcon className="size-4 text-ink-dim [stroke-width:2] md:size-4" />
        <input
          type="search"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          aria-label={label}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[15px] leading-[22px] text-ink-bright caret-accent outline-none placeholder:text-ink-dim"
        />
      </label>
    </div>
  );
}

/**
 * One group: a microlabel header (`In progress · 2`, `Today`) over its rows.
 * `labelClassName` carries the attention hue on a needs-you group; the default
 * is dim ink. `hint` adds the question the group answers (the work page's sections).
 * `headingRef` makes the heading focusable, so focus can land there when a row
 * leaves the group (useRowFocusHandoff).
 */
export function BrowserGroup({
  label,
  count,
  hint,
  labelClassName,
  headingRef,
  children,
}: {
  label: string;
  count?: number;
  /** The question the group answers, in plain type after the label (the work page). */
  hint?: string;
  labelClassName?: string;
  headingRef?: Ref<HTMLHeadingElement>;
  children?: ReactNode;
}) {
  const heading = count === undefined ? label : `${label} · ${count}`;
  return (
    <section aria-label={heading} className="mt-4">
      <h2
        ref={headingRef}
        tabIndex={headingRef === undefined ? undefined : -1}
        className={cn(
          'microlabel mb-2 block border-b border-line pb-1.5 focus-visible:outline-2 focus-visible:outline-accent',
          labelClassName ?? 'text-ink-dim',
        )}
      >
        {heading}
        {hint !== undefined && (
          <span className="ml-2.5 text-meta font-normal tracking-normal text-ink-dim normal-case">
            {hint}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

type RecordTarget =
  | ReturnType<typeof nodeLink>
  | ReturnType<typeof seedLink>
  | { to: '/p/$key/d{$seq}'; params: { key: string; seq: string } }
  | ReturnType<typeof artifactLink>;

/**
 * One row of a browser: an optional leading mark (a status dot), then the id
 * in its own column beside the title column, which holds the title and any
 * chips before or after it, a one-line lede,
 * and a meta line. The title link stretches over the whole row, so the row is
 * the hit target while staying a single real link. The link's name is the
 * title; the id is its description. The title and meta break anywhere, so an
 * unbroken path or URL wraps instead of widening the page on a phone. The lede
 * hides on a phone (the mock's "groups stay, ledes drop"). `actions` trail the
 * row, above the stretched link so they take their own clicks, and wrap under
 * it on a phone, where the strip's empty width still lets a tap through to the
 * link.
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
  actions,
  demoted = false,
  struck = false,
  actionsBelow = false,
}: {
  to: RecordTarget;
  id: string;
  title: string;
  leading?: ReactNode;
  beforeTitle?: ReactNode;
  afterTitle?: ReactNode;
  lede?: string | null;
  meta?: ReactNode;
  /** Buttons that act on the record in place, grouped as "Actions for <id>". */
  actions?: ReactNode;
  /** Finished rows demote by ink tier, never by opacity (ADR 0019 §7). */
  demoted?: boolean;
  /** Strike the title through — an abandoned task. */
  struck?: boolean;
  /** Wrap the actions under the row at every width, for a narrow column (the review rail). */
  actionsBelow?: boolean;
}) {
  const idLabel = useId();
  return (
    <div
      data-row-id={id}
      className={cn(
        'relative flex gap-2.5 rounded-md px-1 py-[7px] transition-colors hover:bg-well-850 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-accent',
        actionsBelow ? 'flex-wrap' : 'max-md:flex-wrap',
      )}
    >
      {leading !== undefined && (
        <span className="flex h-[22px] shrink-0 items-center">{leading}</span>
      )}
      {/* Two columns: the id keeps its own, and everything after it (a
          wrapping title, its chips, the lede, the meta line) hangs in the
          title column instead of dropping under the id. Baseline alignment
          pins the id to the first line. */}
      <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2">
        <span id={idLabel} className="font-mono text-mono-id text-ink-dim">
          {id}
        </span>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {beforeTitle}
          <Link
            {...to}
            aria-describedby={idLabel}
            className={cn(
              'min-w-0 text-title font-medium wrap-anywhere outline-none after:absolute after:inset-0',
              demoted ? 'text-ink-dim' : 'text-ink-bright',
              struck && 'line-through decoration-ink-ghost',
            )}
          >
            {title}
          </Link>
          {afterTitle}
        </div>
        {lede !== undefined && lede !== null && lede !== '' && (
          <p className="col-start-2 truncate text-meta text-ink-dim max-md:hidden">{lede}</p>
        )}
        {meta !== undefined && (
          <div className="col-start-2 mt-0.5 text-meta wrap-anywhere text-ink-dim">{meta}</div>
        )}
      </div>
      {actions !== undefined && (
        <div
          role="group"
          aria-label={`Actions for ${id}`}
          data-row-actions
          className={cn(
            'pointer-events-none relative flex shrink-0 items-start gap-2 *:pointer-events-auto',
            actionsBelow ? 'basis-full flex-wrap' : 'max-md:basis-full max-md:justify-end',
          )}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
