import type { EngineSearchHit } from '@mimir/contract';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { projectsQuery, searchQuery } from '../api/shell-queries';
import { cn } from '../lib/cn';
import { LINK_LABEL, groupHits, highlightTerms, hitStatus } from '../lib/jump';
import { readRecentRecords, rememberRecord } from '../lib/recent-records';
import type { RecentRecord } from '../lib/recent-records';
import { recordLink } from '../lib/record-url';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { IS_APPLE, useCommandHotkey } from '../lib/use-hotkey';
import { lazySheet } from './lazy-sheet';
import { RecordPalette } from './patterns/record-picker';
import type { PaletteChoice, PaletteGroup } from './patterns/record-picker';
import { useSeedCapture } from './seed-capture';
import { StatusDot } from './status-dot';
import { iconButtonClass } from './ui/icon-button';
import { SearchIcon } from './ui/icons';

const AuthoringSheet = lazySheet(async () => (await import('./authoring-sheet')).AuthoringSheet);

/** How long typing must pause before the palette asks the server. */
const SEARCH_DEBOUNCE_MS = 120;

/** A record row's fields: a search hit, or a remembered record without the search's extras. */
type RowRecord = RecentRecord & Partial<Pick<EngineSearchHit, 'lifecycle' | 'link' | 'snippet'>>;

/**
 * The jump palette (MMR-455, mock A "grouped list"): ⌘K or Ctrl-K from any
 * page, or the top-bar button, opens a search across every project. Results
 * group by how they matched; an empty query lists recently opened records and
 * the common actions. A centred box on desktop, full screen on a phone.
 */
export function JumpPalette() {
  const [open, setOpen] = useState(false);
  const [authoring, setAuthoring] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Where focus goes back to on close: what had it when the palette opened,
  // else the top-bar button, which is not a trigger the dialog knows.
  const returnTo = useRef<HTMLElement | null>(null);
  // An action that opens a dialog of its own waits for the palette to finish
  // closing, so the palette's focus return cannot pull focus out of it.
  const afterClose = useRef<(() => void) | null>(null);
  const { key } = useParams({ strict: false });
  const projects = useQuery(projectsQuery);
  // Only a project that exists scopes the search: the server rejects an
  // unknown one, which would fail every search on a mistyped URL.
  const project = projects.data?.some((p) => p.id === key) === true ? key : undefined;
  useCommandHotkey('KeyK', openPalette, { enabled: !open });

  function openPalette() {
    const focused = document.activeElement;
    returnTo.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    setOpen(true);
  }

  function closeThen(after?: () => void) {
    afterClose.current = after ?? null;
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        aria-label="Jump to…"
        aria-haspopup="dialog"
        ref={triggerRef}
        onClick={openPalette}
        className={cn(
          iconButtonClass,
          'md:h-8 md:w-auto md:justify-start md:gap-2 md:border md:border-line md:bg-well-850 md:px-2.5 md:text-meta md:hover:bg-well-850',
        )}
      >
        <SearchIcon className="md:size-3.5 md:[stroke-width:2.25]" />
        <span className="hidden md:inline">Jump to…</span>
        <kbd className="hidden font-mono text-xs text-ink-dim md:inline">
          {IS_APPLE ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
      <PaletteSearch
        open={open}
        project={project}
        onClose={() => {
          closeThen();
        }}
        closeThen={closeThen}
        onNewTask={() => setAuthoring(true)}
        finalFocus={() =>
          returnTo.current?.isConnected === true ? returnTo.current : triggerRef.current
        }
        onClosed={() => {
          const after = afterClose.current;
          if (after === null) {
            return;
          }
          afterClose.current = null;
          // A task later, once the palette has handed focus back to where it
          // was: the next dialog then returns focus there when it closes.
          setTimeout(after, 0);
        }}
      />
      <AuthoringSheet open={authoring} onOpenChange={setAuthoring} projectKey={project} />
    </>
  );
}

/**
 * The palette's search and rows: the Record picker in a Dialog. An empty query
 * lists recent records and the actions; a typed one asks the server once
 * typing pauses, and the rows on screen answer the older query until it lands.
 */
function PaletteSearch({
  open,
  project,
  onClose,
  closeThen,
  onNewTask,
  finalFocus,
  onClosed,
}: {
  open: boolean;
  /** The current page's project, when it has one: ranked first, and named on New task. */
  project: string | undefined;
  onClose: () => void;
  /** Close the palette, then run `after` once it has finished closing. */
  closeThen: (after?: () => void) => void;
  onNewTask: () => void;
  finalFocus: () => HTMLElement | null;
  onClosed: () => void;
}) {
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState(readRecentRecords);
  const [wasOpen, setWasOpen] = useState(open);
  // Each opening starts on an empty query and the records opened since the last.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery('');
      setRecents(readRecentRecords());
    }
  }
  const navigate = useNavigate();
  const router = useRouter();
  const openSeedCapture = useSeedCapture();

  const settled = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const search = useQuery({
    ...searchQuery(settled, project),
    enabled: open && settled !== '',
    placeholderData: keepPreviousData,
  });

  function openRecord(record: RecentRecord, newTab: boolean) {
    rememberRecord({
      id: record.id,
      kind: record.kind,
      project: record.project,
      title: record.title,
    });
    const target = recordLink(record);
    if (newTab) {
      window.open(router.buildLocation(target).href, '_blank', 'noopener');
      return;
    }
    closeThen();
    void navigate(target);
  }

  const recordChoice = (record: RowRecord): PaletteChoice => ({
    content: <RecordRow record={record} query={settled} />,
    key: `record:${record.id}`,
    run: (newTab) => openRecord(record, newTab),
  });

  const searching = query.trim() !== '';
  const groups: PaletteGroup[] = searching
    ? groupHits(search.data?.items ?? []).map((group) => ({
        choices: group.hits.map(recordChoice),
        count: group.hits.length,
        label: group.label,
      }))
    : [
        { choices: recents.map(recordChoice), label: 'Recent' },
        {
          choices: [
            {
              content: (
                <ActionRow icon="+">
                  {project === undefined ? 'New task' : `New task in ${project}`}
                </ActionRow>
              ),
              key: 'action:new-task',
              run: () => closeThen(onNewTask),
            },
            {
              content: (
                <ActionRow icon="✦" hotkey="S">
                  File a seed
                </ActionRow>
              ),
              key: 'action:file-seed',
              run: () => closeThen(openSeedCapture),
            },
          ],
          label: 'Actions',
        },
      ];

  // The rows on screen answer an older query until the search for what is
  // typed now lands: debounce pending, first fetch, or previous data held.
  const waiting =
    searching && (settled !== query.trim() || search.isPending || search.isPlaceholderData);
  const empty = groups.every((group) => group.choices.length === 0);
  let notice: string | undefined;
  if (searching && search.isError) {
    notice = 'Search is unreachable — is the Mimir host running?';
  } else if (searching && !waiting && empty) {
    notice = `No records match “${query.trim()}”.`;
  }

  return (
    <RecordPalette
      open={open}
      onClose={onClose}
      label="Jump to a record or action"
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      waiting={waiting}
      notice={notice}
      hints={['↑↓ move', '↵ open', `${IS_APPLE ? '⌘' : 'Ctrl'}↵ open in new tab`, 'esc close']}
      finalFocus={finalFocus}
      onClosed={onClosed}
    />
  );
}

function RecordRow({ record, query }: { record: RowRecord; query: string }) {
  const status = hitStatus({ lifecycle: record.lifecycle ?? null });
  return (
    <>
      {status === undefined ? (
        <span
          aria-hidden
          className="size-[7px] shrink-0 rounded-full inset-ring inset-ring-ink-faint"
        />
      ) : (
        <StatusDot status={status} />
      )}
      <span className="min-w-16 shrink-0 font-mono text-xs text-ink-dim">{record.id}</span>
      {record.link !== undefined && (
        <span className="shrink-0 font-mono text-xs text-ink-dim">{LINK_LABEL[record.link]}</span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ink">
          {highlightTerms(record.title, query).map((segment, i) =>
            segment.mark ? (
              // oxlint-disable-next-line react/no-array-index-key -- runs of one fixed string
              <mark key={i} className="rounded-sm bg-accent/20 text-ink-bright">
                {segment.text}
              </mark>
            ) : (
              segment.text
            ),
          )}
        </span>
        {record.snippet !== undefined && (
          <span className="truncate text-meta text-ink-dim">{record.snippet}</span>
        )}
      </span>
      <span className="shrink-0 font-mono text-xs text-ink-dim">
        {record.kind === 'task' ? record.project : `${record.project} · ${record.kind}`}
      </span>
    </>
  );
}

function ActionRow({
  icon,
  hotkey,
  children,
}: {
  icon: string;
  hotkey?: string;
  children: ReactNode;
}) {
  return (
    <>
      <span aria-hidden className="w-3.5 shrink-0 text-center text-ink-faint">
        {icon}
      </span>
      <span className="flex-1 text-ink">{children}</span>
      {hotkey !== undefined && (
        <kbd aria-hidden className="font-mono text-xs text-ink-dim">
          {hotkey}
        </kbd>
      )}
    </>
  );
}
