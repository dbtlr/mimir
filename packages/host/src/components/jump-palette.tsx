import type { EngineSearchHit } from '@mimir/contract';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode, RefObject } from 'react';

import { projectsQuery, searchQuery } from '../api/shell-queries';
import { cn } from '../lib/cn';
import { focusPage } from '../lib/focus-main';
import { LINK_LABEL, groupHits, highlightTerms, hitStatus, paletteReturnTarget } from '../lib/jump';
import { readRecentRecords, rememberRecord } from '../lib/recent-records';
import type { RecentRecord } from '../lib/recent-records';
import { recordLink } from '../lib/record-url';
import { DRAWER_TAP_ROW } from '../lib/touch-target';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { IS_APPLE, useCommandHotkey } from '../lib/use-hotkey';
import { lazySheet } from './lazy-sheet';
import { RecordPalette } from './patterns/record-picker';
import type { PaletteChoice, PaletteGroup, PaletteHint } from './patterns/record-picker';
import { useSeedCapture } from './seed-capture';
import { StatusDot } from './status-dot';
import { iconButtonClass } from './ui/icon-button';
import { SearchIcon } from './ui/icons';

const AuthoringSheet = lazySheet(async () => (await import('./authoring-sheet')).AuthoringSheet);

/** How long typing must pause before the palette asks the server. */
const SEARCH_DEBOUNCE_MS = 120;

/** A record row's fields: a search hit, or a remembered record without the search's extras. */
type RowRecord = RecentRecord & Partial<Pick<EngineSearchHit, 'lifecycle' | 'link' | 'snippet'>>;

/** The palette's shortcut, as drawn beside a Jump to control. */
const SHORTCUT = IS_APPLE ? '⌘K' : 'Ctrl K';
/** The same shortcut for assistive technology (`aria-keyshortcuts`). */
const KEY_SHORTCUTS = IS_APPLE ? 'Meta+K' : 'Control+K';

type JumpPalette = {
  /** Open the palette; closing it hands focus back to `returnTo`, else to what has focus now. */
  open: (returnTo?: HTMLElement | null) => void;
  /** Register a Jump to control as a place focus may return to; returns its unregister. */
  register: (control: HTMLElement) => () => void;
};

const JumpPaletteContext = createContext<JumpPalette | null>(null);

function useJumpPalette(): JumpPalette {
  const palette = useContext(JumpPaletteContext);
  if (palette === null) {
    throw new Error('A Jump to control needs the JumpPaletteProvider above it.');
  }
  return palette;
}

/** Register `control` with the palette while it is mounted, so focus can return to it. */
function useJumpControl(control: RefObject<HTMLElement | null>): JumpPalette {
  const palette = useJumpPalette();
  const { register } = palette;
  useEffect(() => {
    const node = control.current;
    return node === null ? undefined : register(node);
  }, [control, register]);
  return palette;
}

/**
 * The jump palette (MMR-455, mock A "grouped list"): ⌘K or Ctrl-K from any
 * page, or a Jump to control, opens a search across every project. Results
 * group by how they matched; an empty query lists recently opened records and
 * the common actions. A centred box on desktop, full screen on a phone.
 *
 * The shell mounts it once. Its controls sit where the frame puts them (ADR
 * 0013, MMR-729 refinement): `SidebarJumpTo` at the top of the sidebar and
 * the drawer, and `TopBarJumpTo` in the top bar where no sidebar is beside
 * the page.
 */
export function JumpPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [authoring, setAuthoring] = useState(false);
  // Where focus goes back to on close: what had it when the palette opened,
  // else a Jump to control on screen, none of which is a trigger the dialog knows.
  const returnTo = useRef<HTMLElement | null>(null);
  const controls = useRef(new Set<HTMLElement>());
  // An action that opens a dialog of its own waits for the palette to finish
  // closing, so the palette's focus return cannot pull focus out of it.
  const afterClose = useRef<(() => void) | null>(null);
  const { key } = useParams({ strict: false });
  const projects = useQuery(projectsQuery);
  // Only a project that exists scopes the search: the server rejects an
  // unknown one, which would fail every search on a mistyped URL.
  const project = projects.data?.some((p) => p.id === key) === true ? key : undefined;
  const openPalette = useCallback((opener?: HTMLElement | null) => {
    const focused = opener ?? document.activeElement;
    returnTo.current = focused instanceof HTMLElement ? focused : null;
    setOpen(true);
  }, []);
  useCommandHotkey('KeyK', () => openPalette(), { enabled: !open });

  function closeThen(after?: () => void) {
    afterClose.current = after ?? null;
    setOpen(false);
  }

  const register = useCallback((control: HTMLElement) => {
    controls.current.add(control);
    return () => {
      controls.current.delete(control);
    };
  }, []);
  const palette = useMemo<JumpPalette>(
    () => ({ open: openPalette, register }),
    [openPalette, register],
  );

  return (
    <JumpPaletteContext.Provider value={palette}>
      {children}
      <PaletteSearch
        open={open}
        project={project}
        onClose={() => {
          closeThen();
        }}
        closeThen={closeThen}
        onNewTask={() => setAuthoring(true)}
        finalFocus={() =>
          paletteReturnTarget([returnTo.current, ...controls.current]) ?? focusPage()
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
    </JumpPaletteContext.Provider>
  );
}

/**
 * The top bar's Jump to, where no sidebar is beside the page: an icon button
 * on a phone, and from `md` a small field with its shortcut.
 */
export function TopBarJumpTo() {
  const control = useRef<HTMLButtonElement>(null);
  const palette = useJumpControl(control);
  return (
    <button
      type="button"
      aria-label="Jump to…"
      aria-haspopup="dialog"
      aria-keyshortcuts={KEY_SHORTCUTS}
      ref={control}
      onClick={() => {
        palette.open();
      }}
      className={cn(
        iconButtonClass,
        'md:h-8 md:w-auto md:justify-start md:gap-2 md:border md:border-line md:bg-well-850 md:px-2.5 md:text-meta md:hover:bg-well-850',
      )}
    >
      <SearchIcon className="md:size-3.5 md:[stroke-width:2.25]" />
      <span className="hidden md:inline">Jump to…</span>
      <kbd className="hidden font-mono text-xs text-ink-dim md:inline">{SHORTCUT}</kbd>
    </button>
  );
}

/**
 * Jump to at the top of the sidebar (DESIGN.md, Pages): a full-width button
 * drawn as a search field, 36 tall beside the page and a 44 tap row in the
 * drawer, as the drawer's other rows are. Beside the page it opens the palette
 * and shows the shortcut. The drawer passes `onJump`, which closes the drawer
 * before the palette opens; a drawer is opened by touch, so there it draws no
 * shortcut.
 */
export function SidebarJumpTo({ onJump }: { onJump?: () => void }) {
  const control = useRef<HTMLButtonElement>(null);
  const palette = useJumpControl(control);
  return (
    <button
      type="button"
      aria-label="Jump to…"
      aria-haspopup="dialog"
      aria-keyshortcuts={KEY_SHORTCUTS}
      ref={control}
      onClick={() => {
        if (onJump === undefined) {
          palette.open();
        } else {
          onJump();
        }
      }}
      className={cn(
        // 10 below, plus the sidebar's 2 row gap: DESIGN.md's 12 above the switcher.
        'mb-2.5 flex w-full items-center gap-2 rounded-lg border border-ink-dim bg-well-850 px-3 text-label font-normal text-ink-dim transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'min-h-9',
        DRAWER_TAP_ROW,
      )}
    >
      <SearchIcon className="size-4" />
      <span>Jump to…</span>
      {onJump === undefined && (
        <kbd className="ml-auto font-mono text-xs text-ink-dim">{SHORTCUT}</kbd>
      )}
    </button>
  );
}

/** The palette's open function, for a control that opens it on another's behalf (the drawer). */
export function useOpenJumpPalette(): JumpPalette['open'] {
  return useJumpPalette().open;
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
      hints={HINTS}
      finalFocus={finalFocus}
      onClosed={onClosed}
    />
  );
}

/** The palette's key hints: ⌘ on a Mac, Ctrl elsewhere. */
const HINTS: readonly PaletteHint[] = [
  { action: 'move', keys: ['up', 'down'] },
  { action: 'open', keys: ['enter'] },
  { action: 'open in new tab', keys: [IS_APPLE ? 'command' : 'Ctrl', 'enter'] },
  { action: 'close', keys: ['Esc'] },
];

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
