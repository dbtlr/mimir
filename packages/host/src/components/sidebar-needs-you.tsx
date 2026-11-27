import { useQuery } from '@tanstack/react-query';
import { useLinkProps, useRouterState } from '@tanstack/react-router';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { reviewQuery } from '../api/view-queries';
import { cn } from '../lib/cn';
import { projectPlaceOf } from '../lib/project-sidebar';
import { deliveryPath } from '../lib/record-url';
import { STATUS_META } from '../lib/status';
import { openLink } from './needs-you-cards';
import { needsYouCards } from './needs-you-deck-model';
import type { NeedsYouCard, NeedsYouLead, NeedsYouOpen } from './needs-you-deck-model';
import { FEED_LINK_TEXT } from './patterns/feed/link';
import { useProjectStructure } from './sidebar-containers';
import { SIDEBAR_ROW } from './sidebar-selection';
import { StatusDot } from './status-dot';
import { Skeleton } from './ui/skeleton';

/*
 * The sidebar's Needs you slot (ADR 0013, MMR-804 refinement): on a project's
 * pages, under the switcher, the project's Needs you deck in brief, read from
 * the review report the console already polls. Nothing in it links to the
 * page you are on or marks it current, so the container list below keeps the
 * sidebar's one selection.
 */

/** The rows the slot shows; "See all N" leads to the rest. */
const SHOWN = 3;

/** With the sidebar's 2 gap, the slot's hairline sits 12 above the container list. */
const SLOT_END = 'mb-2.5';

/** A row that is the page you are on: drawn as a row, with no hover, since it leads nowhere. */
const PLAIN_ROW = cn(SIDEBAR_ROW, 'hover:bg-transparent');

/** The loading rows' bars, ragged as titles are. */
const SKELETON_WIDTHS = ['w-[88%]', 'w-[72%]', 'w-[80%]'];

/** Where the page is, as the slot's current-page rule reads it. */
type Here = { pathname: string; onWorkTab: boolean };

/**
 * Whether a card's Open leads to the page you are on: a task's or delivery's
 * own page whatever its tab, or, for the project's decisions without a
 * delivery, the project's Work tab.
 */
function opensHere(open: NeedsYouOpen, here: Here): boolean {
  switch (open.kind) {
    case 'task': {
      const place = projectPlaceOf(here.pathname);
      return place?.kind === 'node' && place.id === open.id;
    }
    case 'delivery': {
      return here.pathname.replace(/\/$/u, '') === deliveryPath(open.id);
    }
    case 'project': {
      return here.onWorkTab;
    }
    default: {
      const unexpected: never = open;
      return unexpected;
    }
  }
}

/** The page's place as the slot needs it: its path, and whether it is the project's Work tab. */
function useHere(): Here {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onDetails = useRouterState({
    select: (s): boolean => 'tab' in s.location.search && s.location.search.tab === 'details',
  });
  return {
    onWorkTab: projectPlaceOf(pathname)?.kind === 'project' && !onDetails,
    pathname,
  };
}

/**
 * A slot link. The router marks a link to `/p/KEY` active on every page under
 * it; nothing in the slot is current, so its `aria-current` is dropped.
 */
function SlotLink({
  to,
  className,
  onNavigate,
  children,
}: {
  to: ReturnType<typeof openLink>;
  className: string;
  onNavigate?: (() => void) | undefined;
  children: ReactNode;
}) {
  const linkProps = useLinkProps({ ...to, onClick: onNavigate });
  return (
    <a {...linkProps} aria-current={undefined} className={className}>
      {children}
    </a>
  );
}

/** A card's lead: the 7 attention dot or a blocked task's status dot, then its word. */
function Lead({ lead }: { lead: NeedsYouLead }) {
  return (
    <>
      {lead.kind === 'attention' ? (
        <span aria-hidden className="inline-block size-[7px] shrink-0 rounded-full bg-attention" />
      ) : (
        <StatusDot status={lead.status} />
      )}
      <span className="shrink-0 font-semibold text-ink-bright">
        {lead.kind === 'attention' ? lead.word : STATUS_META[lead.status].label}
      </span>
    </>
  );
}

/**
 * One card's row: its lead, then its title, read by a screen reader in that
 * order. It links where the card's Open leads, or is plain text on that page.
 */
function CardRow({
  card,
  here,
  onNavigate,
}: {
  card: NeedsYouCard;
  here: Here;
  onNavigate?: (() => void) | undefined;
}) {
  const { open } = card.preview;
  const content = (
    <>
      <Lead lead={card.lead} />
      {/* The space parts the row's accessible name; flex layout drops it visually. */}{' '}
      <span className="min-w-0 flex-1 truncate">{card.title}</span>
    </>
  );
  return opensHere(open, here) ? (
    <div className={PLAIN_ROW}>{content}</div>
  ) : (
    <SlotLink to={openLink(open)} className={SIDEBAR_ROW} onNavigate={onNavigate}>
      {content}
    </SlotLink>
  );
}

/**
 * "See all N" to the project's Work tab, in the See all treatment, its words
 * lined up with the lead words past the 7 dot. On the Work tab it is the page,
 * so it is plain text in 500 `ink-bright`.
 */
function SeeAll({
  projectKey,
  count,
  here,
  onNavigate,
}: {
  projectKey: string;
  count: number;
  here: Here;
  onNavigate?: (() => void) | undefined;
}) {
  const content = (
    <>
      <span aria-hidden="true" className="w-[7px] shrink-0" />
      See all {count.toLocaleString('en-US')}
    </>
  );
  return here.onWorkTab ? (
    <div className={cn(PLAIN_ROW, 'font-medium text-ink-bright')}>{content}</div>
  ) : (
    <SlotLink
      to={{ params: { key: projectKey }, to: '/p/$key' }}
      className={cn(SIDEBAR_ROW, FEED_LINK_TEXT, 'font-medium')}
      onNavigate={onNavigate}
    >
      {content}
    </SlotLink>
  );
}

/** The 1px hairline that closes the slot in every state, 12 below its last line. */
function Hairline() {
  return <div aria-hidden="true" className="mt-3 h-px bg-line" />;
}

/**
 * The slot's head over its body: "Needs you" and, once the report has
 * answered, the count of the project's cards. The head names the group.
 */
function Headed({
  count,
  busy = false,
  children,
}: {
  count?: number;
  busy?: boolean;
  children: ReactNode;
}) {
  const head = useId();
  return (
    <div
      role="group"
      aria-labelledby={head}
      aria-busy={busy ? 'true' : undefined}
      className={SLOT_END}
    >
      <p
        id={head}
        className="mb-1 flex items-baseline gap-2 px-2 text-label font-semibold text-ink-bright"
      >
        Needs you
        {count !== undefined && (
          <>
            {' '}
            <span className="text-meta font-normal text-ink-dim">
              {count.toLocaleString('en-US')}
            </span>
          </>
        )}
      </p>
      <div className="flex flex-col">{children}</div>
      <Hairline />
    </div>
  );
}

/**
 * The slot on a project's pages, or nothing where it does not show: once the
 * review report answers, it shows when the report lists the project; until
 * then, unless the archived list names the project or its tree reads as
 * missing or not a project. `onNavigate` lets the drawer close behind a pick.
 */
export function ProjectNeedsYou({
  projectKey,
  onNavigate,
}: {
  projectKey: string;
  onNavigate?: (() => void) | undefined;
}) {
  const review = useQuery(reviewQuery());
  const { archived, unavailable } = useProjectStructure(projectKey);
  const here = useHere();
  const report = review.data;

  if (report === undefined) {
    if (archived !== undefined || unavailable) {
      return null;
    }
    return review.isError ? (
      <Headed>
        <p className="px-2 text-body text-status-blocked-foreground">
          Couldn’t load what needs you.
        </p>
      </Headed>
    ) : (
      <Headed busy>
        {SKELETON_WIDTHS.map((width) => (
          <div key={width} data-testid="needs-you-skeleton" className={PLAIN_ROW}>
            <Skeleton className={cn('h-3', width)} />
          </div>
        ))}
      </Headed>
    );
  }

  const project = report.projects.find((each) => each.key === projectKey);
  if (project === undefined) {
    return null;
  }
  const cards = needsYouCards(report).filter((card) => card.projectKey === projectKey);
  if (cards.length === 0) {
    return (
      <div className={SLOT_END}>
        <p className="px-2 text-body text-ink">Nothing needs you in {project.name}.</p>
        <Hairline />
      </div>
    );
  }
  return (
    <Headed count={cards.length}>
      {cards.slice(0, SHOWN).map((card) => (
        <CardRow key={card.key} card={card} here={here} onNavigate={onNavigate} />
      ))}
      {cards.length > SHOWN && (
        <SeeAll projectKey={projectKey} count={cards.length} here={here} onNavigate={onNavigate} />
      )}
    </Headed>
  );
}
