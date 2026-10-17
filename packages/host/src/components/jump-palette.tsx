import { Dialog } from '@base-ui-components/react/dialog';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

import { projectsQuery, searchQuery } from '../api/queries';
import type { WireSearchHit } from '../api/types';
import { cn } from '../lib/cn';
import { LINK_LABEL, groupHits, highlightTerms, hitStatus } from '../lib/jump';
import { readRecentRecords, rememberRecord } from '../lib/recent-records';
import type { RecentRecord } from '../lib/recent-records';
import { recordLink } from '../lib/record-url';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { IS_APPLE, useCommandHotkey } from '../lib/use-hotkey';
import { AuthoringSheet } from './authoring-sheet';
import { useSeedCapture } from './seed-capture';
import { StatusDot } from './status-dot';

/** How long typing must pause before the palette asks the server. */
const SEARCH_DEBOUNCE_MS = 120;

/** A record row's fields: a search hit, or a remembered record without the search's extras. */
type RowRecord = RecentRecord & Partial<Pick<WireSearchHit, 'lifecycle' | 'link' | 'snippet'>>;

/** One choosable row: a record to open or an action to run. */
type Choice = {
  key: string;
  /** Run the choice; `newTab` asks a record to open in a new browser tab. */
  run: (newTab: boolean) => void;
  content: ReactNode;
};

type ChoiceGroup = { label: string; count?: number; choices: Choice[] };

/**
 * The jump palette (MMR-455, mock A "grouped list"): ⌘K or Ctrl-K from any
 * page, or the top-bar button, opens a search across every project. Results
 * group by how they matched; an empty query lists recently opened records and
 * the common actions. A centred box on desktop, full screen on a phone.
 */
export function JumpPalette() {
  const [open, setOpen] = useState(false);
  const [authoring, setAuthoring] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Where focus goes back to on close: what had it when the palette opened,
  // else the top-bar button. The button is not a base-ui trigger, so base-ui
  // would otherwise drop focus on the page body.
  const returnTo = useRef<HTMLElement | null>(null);
  // An action that opens a dialog of its own waits for the palette to finish
  // closing, so the palette's focus return cannot pull focus out of it.
  const afterClose = useRef<(() => void) | null>(null);
  const { key } = useParams({ strict: false });
  const projects = useQuery(projectsQuery);
  // Only a project that exists scopes the search: the server rejects an
  // unknown one, which would fail every search on a mistyped URL.
  const project = projects.data?.items.some((p) => p.id === key) === true ? key : undefined;
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
        className="flex h-9 min-w-9 items-center justify-center gap-2 rounded text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent md:h-8 md:justify-start md:border md:border-line md:bg-well-850 md:px-2.5 md:text-meta"
      >
        <span aria-hidden>⌕</span>
        <span className="hidden md:inline">Jump to…</span>
        <kbd className="hidden font-mono text-micro text-ink-faint md:inline">
          {IS_APPLE ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
      <Dialog.Root
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(isOpen) => {
          const after = afterClose.current;
          if (isOpen || after === null) {
            return;
          }
          afterClose.current = null;
          // A task later, once the palette has handed focus back to where it
          // was: the next dialog then returns focus there when it closes.
          setTimeout(after, 0);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-well-950/70 backdrop-blur-[2px]" />
          <Dialog.Popup
            aria-label="Jump to a record or action"
            initialFocus={inputRef}
            finalFocus={() =>
              returnTo.current?.isConnected === true ? returnTo.current : triggerRef.current
            }
            className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-well-850 outline-none md:inset-auto md:top-16 md:left-1/2 md:max-h-[min(560px,80dvh)] md:w-[min(620px,calc(100vw-2rem))] md:-translate-x-1/2 md:rounded-2xl md:border md:border-line-bright md:shadow-2xl light:md:shadow-overlay"
          >
            {open && (
              <PaletteBody
                project={project}
                inputRef={inputRef}
                closeThen={closeThen}
                onNewTask={() => setAuthoring(true)}
              />
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <AuthoringSheet open={authoring} onOpenChange={setAuthoring} projectKey={project} />
    </>
  );
}

function PaletteBody({
  project,
  inputRef,
  closeThen,
  onNewTask,
}: {
  /** The current page's project, when it has one: ranked first, and named on New task. */
  project: string | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Close the palette, then run `after` once it has finished closing. */
  closeThen: (after?: () => void) => void;
  onNewTask: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const navigate = useNavigate();
  const router = useRouter();
  const openSeedCapture = useSeedCapture();
  const listId = useId();
  const [recents] = useState(readRecentRecords);

  const settled = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const search = useQuery({
    ...searchQuery(settled, project),
    enabled: settled !== '',
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

  const recordChoice = (record: RowRecord): Choice => ({
    content: <RecordRow record={record} query={settled} />,
    key: `record:${record.id}`,
    run: (newTab) => openRecord(record, newTab),
  });

  const groups: ChoiceGroup[] =
    query.trim() === ''
      ? [
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
        ]
      : groupHits(search.data?.items ?? []).map((group) => ({
          choices: group.hits.map(recordChoice),
          count: group.hits.length,
          label: group.label,
        }));
  const shown = groups.filter((group) => group.choices.length > 0);
  const choices = shown.flatMap((group) => group.choices);
  // The highlight follows its choice while results refresh, and falls back to the first.
  const activeIndex = Math.max(
    0,
    choices.findIndex((c) => c.key === activeKey),
  );
  const active = choices.at(activeIndex);
  const optionId = (choice: Choice) => `${listId}-${choice.key}`;
  const activeOptionId = active === undefined ? undefined : optionId(active);

  // The rows on screen answer an older query until the search for what is
  // typed now lands: debounce pending, first fetch, or previous data held.
  const searching = query.trim() !== '';
  const waiting =
    searching && (settled !== query.trim() || search.isPending || search.isPlaceholderData);

  // Enter pressed while waiting is held for the fresh results, so it never
  // opens a record the old query found. The value is its new-tab flag.
  const heldEnter = useRef<boolean | null>(null);
  const runHeldEnter = useEffectEvent(() => {
    const newTab = heldEnter.current;
    heldEnter.current = null;
    if (newTab !== null) {
      active?.run(newTab);
    }
  });
  useEffect(() => {
    if (!waiting) {
      runHeldEnter();
    }
  }, [waiting]);

  // The input keeps focus, so the list scrolls the highlighted row into view.
  useEffect(() => {
    if (activeOptionId !== undefined) {
      document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeOptionId]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter that commits an IME composition is not a choice.
    if (event.nativeEvent.isComposing) {
      return;
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step !== undefined && choices.length > 0) {
      event.preventDefault();
      const next = choices.at((activeIndex + step) % choices.length);
      setActiveKey(next?.key ?? null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const newTab = event.metaKey || event.ctrlKey;
      if (waiting) {
        heldEnter.current = newTab;
      } else {
        active?.run(newTab);
      }
    }
  }
  let notice: string | undefined;
  if (searching && search.isError) {
    notice = 'Search is unreachable — is the Mimir host running?';
  } else if (searching && !waiting && choices.length === 0) {
    notice = `No records match “${query.trim()}”.`;
  }

  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span aria-hidden className="text-ink-faint">
          ⌕
        </span>
        <input
          role="combobox"
          aria-label="Jump to a record or action"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveKey(null);
            heldEnter.current = null;
          }}
          onKeyDown={onKeyDown}
          placeholder="Jump to a record or action"
          className="min-w-0 flex-1 bg-transparent text-base text-ink-bright outline-none placeholder:text-ink-faint"
        />
        <Dialog.Close className="rounded px-2 py-1 text-meta text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent md:hidden">
          Cancel
        </Dialog.Close>
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="Results"
        aria-busy={waiting}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-2 py-1.5 transition-opacity',
          waiting && 'opacity-60',
        )}
      >
        {shown.map((group) => (
          <ChoiceGroupView
            key={group.label}
            group={group}
            activeKey={active?.key}
            optionId={optionId}
            onHover={setActiveKey}
            stale={waiting}
          />
        ))}
        {notice !== undefined && <p className="px-2 py-3 text-meta text-ink-faint">{notice}</p>}
      </div>
      <div
        aria-hidden
        className="hidden flex-wrap gap-3.5 border-t border-line px-4 py-2 font-mono text-micro text-ink-faint md:flex"
      >
        <span>↑↓ move</span>
        <span>↵ open</span>
        <span>{IS_APPLE ? '⌘' : 'Ctrl'}↵ open in new tab</span>
        <span>esc close</span>
      </div>
    </>
  );
}

function ChoiceGroupView({
  group,
  activeKey,
  optionId,
  onHover,
  stale,
}: {
  group: ChoiceGroup;
  activeKey: string | undefined;
  optionId: (choice: Choice) => string;
  onHover: (key: string) => void;
  /** The rows answer an older query: a click must not open one, as Enter would not. */
  stale: boolean;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="py-1">
      <div id={labelId} className="microlabel px-2 pt-1.5 pb-1 text-ink-faint">
        {group.label}
        {group.count !== undefined && ` · ${String(group.count)}`}
      </div>
      {group.choices.map((choice) => {
        const selected = choice.key === activeKey;
        return (
          // The input owns focus and the keys (aria-activedescendant); a row
          // takes only the pointer.
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
          <div
            key={choice.key}
            id={optionId(choice)}
            role="option"
            tabIndex={-1}
            aria-selected={selected}
            onMouseMove={() => onHover(choice.key)}
            // Keep focus in the input, so the keys still drive the list after a click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              if (!stale) {
                choice.run(e.metaKey || e.ctrlKey);
              }
            }}
            className={cn(
              'flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm',
              selected && 'bg-accent/10 inset-ring inset-ring-accent/25',
            )}
          >
            {choice.content}
          </div>
        );
      })}
    </div>
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
      <span className="min-w-16 shrink-0 font-mono text-micro text-ink-dim">{record.id}</span>
      {record.link !== undefined && (
        <span className="shrink-0 font-mono text-micro text-ink-faint">
          {LINK_LABEL[record.link]}
        </span>
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
          <span className="truncate text-meta text-ink-faint">{record.snippet}</span>
        )}
      </span>
      <span className="shrink-0 font-mono text-micro text-ink-faint">
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
        <kbd aria-hidden className="font-mono text-micro text-ink-faint">
          {hotkey}
        </kbd>
      )}
    </>
  );
}
