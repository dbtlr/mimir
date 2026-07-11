import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { Priority, SeedKind, Size } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { toast } from 'sonner';

import { useCreateNode, useDepend, usePromoteSeed } from '../api/mutations';
import type { CreateNodeInput, PromoteSeedInput } from '../api/mutations';
import { projectsQuery, tasksQuery, treeQuery } from '../api/queries';
import type { WireNode } from '../api/types';
import { projectKeyOf } from '../api/types';
import { cn } from '../lib/cn';
import { homeOptions } from '../lib/parent-options';
import type { AuthoringType } from '../lib/parent-options';
import { StatusDot } from './status-dot';
import { ActionButton } from './ui/action-button';
import { SegmentedControl } from './ui/segmented-control';
import { Sheet, SheetContent, SheetTitle } from './ui/sheet';

const TYPE_OPTIONS = [
  { label: 'Task', value: 'task' },
  { label: 'Phase', value: 'phase' },
  { label: 'Initiative', value: 'initiative' },
] as const satisfies readonly { label: string; value: AuthoringType }[];

const SEARCH_DEBOUNCE_MS = 250;
const DEP_HELPER =
  "this task won't read ready until its prerequisites are done — inherited by any children";

/** The hairline field shell (mock 19a's .16 border on the page well). */
const FIELD_SHELL = 'rounded-[9px] border border-line-bright bg-well-900';

/** Selected-pill wash per priority — the PriorityBadge hues, sheet-local shape. */
const PRIORITY_WASH: Record<Priority, string> = {
  p0: 'bg-status-blocked/12 inset-ring-status-blocked/24 text-status-blocked-foreground',
  p1: 'bg-status-in-progress/12 inset-ring-status-in-progress/24 text-status-in-progress-foreground',
  p2: 'bg-well-800 text-ink',
  p3: 'bg-well-800 text-ink-dim',
};

const SIZE_GLYPH: Record<Size, string> = { large: 'l', medium: 'm', small: 's' };

/** DOM id for a dep-results option — the combobox's aria-activedescendant target. */
function depOptionDomId(id: string) {
  return `authoring-dep-option-${id}`;
}

/** MMR-248 seam: the promote flow pre-fills these without forking the sheet. */
export type AuthoringPrefill = {
  title?: string;
  description?: string;
  /** A parent node id (task/phase) or project KEY (initiative) to land in. */
  home?: string;
};

/**
 * MMR-248 promote mode: the same sheet, germinating a seed into a task. Its
 * presence locks the type to `task`, swaps the submit to
 * `POST /api/seeds/:id/promote`, and turns on the provenance strip + promote
 * footer. `kind` drives the honest home suggestion (bug → the project's lone
 * standing container, else no suggestion).
 */
export type AuthoringPromote = {
  seedId: string;
  kind: SeedKind;
};

export type AuthoringSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The scope's project — the board pre-fills it; omitted, the first project wins. */
  projectKey?: string;
  offline?: boolean;
  /** "Create & open" routes the fresh node here (`?node=<id>`). */
  onOpenNode?: (id: string) => void;
  prefill?: AuthoringPrefill;
  /**
   * MMR-248: the prefill description is still loading (the promote body read is
   * in flight). The sheet shows a pending affordance and folds the body in once
   * it lands — unless the user has already started editing.
   */
  descriptionPending?: boolean;
  /** MMR-248 seam: replaces the NEW microlabel (e.g. PROMOTE SEED + kind chip). */
  headerSlot?: ReactNode;
  /** MMR-248: present in promote mode — germinate a seed rather than create a node. */
  promote?: AuthoringPromote;
};

/**
 * Closes the innermost open popup (home picker, dep results) ahead of a sheet
 * dismissal; returns true when it consumed the dismissal.
 */
type DismissGuard = () => boolean;

/**
 * The authoring sheet (Meridian 19a, MMR-227) — one create surface for
 * task / phase / initiative behind a type selector, with a project-spanning
 * HOME picker, always-visible markdown description, and a DEPENDS-ON chip
 * field. Nodes are born `new`; no status control exists here (ADR 0019 §5).
 * Deps apply post-create (`/depend`) — accepted non-atomicity: on a depend
 * failure the node survives, the error toasts, and the sheet holds a
 * retry-deps posture pinned to the created node (never a duplicate create).
 */
export function AuthoringSheet(props: AuthoringSheetProps) {
  const dismissGuard = useRef<DismissGuard | null>(null);
  return (
    <Sheet
      open={props.open}
      onOpenChange={(next) => {
        // Esc closes the innermost open popup first; the sheet — and the
        // typed form state its unmount destroys — only goes on the next one.
        if (!next && dismissGuard.current?.() === true) {
          return;
        }
        props.onOpenChange(next);
      }}
    >
      {props.open && (
        <AuthoringSheetBody key={props.promote?.seedId} {...props} dismissGuardRef={dismissGuard} />
      )}
    </Sheet>
  );
}

function AuthoringSheetBody({
  onOpenChange,
  projectKey,
  offline,
  onOpenNode,
  prefill,
  descriptionPending,
  headerSlot,
  promote,
  dismissGuardRef,
}: AuthoringSheetProps & { dismissGuardRef: RefObject<DismissGuard | null> }) {
  const [type, setType] = useState<AuthoringType>('task');
  const [title, setTitle] = useState(prefill?.title ?? '');
  const [description, setDescription] = useState(prefill?.description ?? '');
  const [projectPick, setProjectPick] = useState(() =>
    prefill?.home !== undefined ? projectKeyOf(prefill.home) : (projectKey ?? ''),
  );
  const [parentPick, setParentPick] = useState(prefill?.home ?? '');
  const [homeOpen, setHomeOpen] = useState(false);
  const [deps, setDeps] = useState<WireNode[]>([]);
  const [depSearch, setDepSearch] = useState('');
  const [depQ, setDepQ] = useState('');
  const [depActive, setDepActive] = useState(0);
  const [depsOpen, setDepsOpen] = useState(false);
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [priority, setPriority] = useState('');
  const [size, setSize] = useState('');
  // Raw tag text, TaskForm's MMR-257 pattern: parsing never rewrites mid-typing.
  const [tagsText, setTagsText] = useState('');
  const [tagEntryOpen, setTagEntryOpen] = useState(false);
  const [createAnother, setCreateAnother] = useState(false);
  // Partial-failure marker: the node a prior submit created whose depend
  // failed — the next submit retries the attach instead of re-creating.
  const [created, setCreated] = useState<WireNode | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // The description auto-fills from the (late) promote body only until the user
  // types — this guards the sync effect from clobbering an in-progress edit.
  const descriptionTouched = useRef(false);

  const projects = useQuery(projectsQuery);
  const projectItems = projects.data?.items ?? [];
  const projKey = projectPick !== '' ? projectPick : (projectItems[0]?.id ?? '');
  const projTitle = projectItems.find((p) => p.id === projKey)?.title ?? projKey;

  const tree = useQuery({
    ...treeQuery(projKey),
    enabled: projKey !== '' && type !== 'initiative',
  });
  const homes =
    type !== 'initiative' && tree.data !== undefined ? homeOptions(type, tree.data) : [];
  // MMR-248 honest home suggestion: a bug germinates into the project's standing
  // (open-ended) container — but ONLY when exactly one determinate candidate
  // exists. Any other kind (or an ambiguous set) yields no suggestion, so the
  // picker's normal first-home default stands and no "suggested" label is shown.
  const suggestedHome =
    promote !== undefined && promote.kind === 'bug'
      ? (() => {
          const standing = homes.filter((h) => h.openEnded);
          return standing.length === 1 ? standing[0] : undefined;
        })()
      : undefined;
  // A stale pick (after a type/project switch) falls back to the suggestion, then
  // the first legal home. Until the user picks, the suggestion is the effective home.
  const pickedHome = homes.find((h) => h.id === parentPick) ?? suggestedHome ?? homes[0];
  const effectiveParent = type === 'initiative' ? projKey : (pickedHome?.id ?? '');
  const homesPending = type !== 'initiative' && projKey !== '' && tree.isPending;

  // Debounced dep search (the tasks-browser pattern): box updates now, query trails.
  useEffect(() => {
    if (depSearch === depQ) {
      return undefined;
    }
    const t = setTimeout(() => {
      setDepQ(depSearch);
      setDepActive(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [depSearch, depQ]);
  // MMR-248: the promote body read lands after the sheet is already open — fold
  // the seed description into the field once it arrives, unless the user has
  // already edited it (the touched guard keeps a late read from clobbering).
  const prefillDescription = prefill?.description;
  useEffect(() => {
    if (!descriptionTouched.current && prefillDescription !== undefined) {
      setDescription(prefillDescription);
    }
  }, [prefillDescription]);
  const depQuery = useQuery({
    ...tasksQuery({ q: depQ }),
    enabled: type === 'task' && depQ.trim() !== '',
  });
  const depOptions = (depQuery.data?.items ?? [])
    .filter((n) => !deps.some((d) => d.id === n.id))
    .slice(0, 8);
  const depListOpen = type === 'task' && depSearch.trim() !== '' && depQ.trim() !== '';
  const depActiveOption = depOptions[depActive] ?? depOptions[0];

  // Register the innermost-popup guard so Esc dismisses the open dropdown
  // (home picker, then dep results) before it ever reaches the sheet.
  useEffect(() => {
    dismissGuardRef.current = () => {
      if (homeOpen) {
        setHomeOpen(false);
        return true;
      }
      if (depListOpen) {
        setDepSearch('');
        setDepQ('');
        return true;
      }
      return false;
    };
    return () => {
      dismissGuardRef.current = null;
    };
  });

  const create = useCreateNode();
  const depend = useDepend();
  const promoteSeed = usePromoteSeed(promote?.seedId ?? '');
  const submitting = create.isPending || depend.isPending || promoteSeed.isPending;
  const canCreate =
    offline !== true &&
    !submitting &&
    !homesPending &&
    title.trim() !== '' &&
    effectiveParent !== '';

  const tags = tagsText
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // The shared signal assembly (MMR-248) — description/tags plus the task-only
  // priority/size — folded onto whichever payload (create or promote) so the two
  // builders can't drift. Priority/size gate on `type` (containers omit them;
  // promote is always a task, so they ride there).
  function assignSignals(
    input: Pick<CreateNodeInput, 'description' | 'tags' | 'priority' | 'size'>,
  ) {
    const desc = description.trim();
    if (desc !== '') {
      input.description = desc;
    }
    if (tags.length > 0) {
      input.tags = tags;
    }
    if (type === 'task') {
      if (priority !== '') {
        input.priority = priority;
      }
      if (size !== '') {
        input.size = size;
      }
    }
  }

  function buildInput(): CreateNodeInput {
    const input: CreateNodeInput = { parent: effectiveParent, title: title.trim(), type };
    assignSignals(input);
    return input;
  }

  function buildPromoteInput(): PromoteSeedInput {
    const input: PromoteSeedInput = { parent: effectiveParent, title: title.trim() };
    assignSignals(input);
    return input;
  }

  // MMR-248 promote submit: one POST to the promote endpoint (never the create
  // route). Success toasts the spawned task id, invalidates seeds + node keys via
  // the hook, and closes; "& open" routes to the created task's dossier.
  async function handlePromote(openAfter: boolean) {
    if (!canCreate || promote === undefined) {
      return;
    }
    let result: Awaited<ReturnType<typeof promoteSeed.mutateAsync>>;
    try {
      result = await promoteSeed.mutateAsync(buildPromoteInput());
    } catch {
      return; // toasted by the hook; the sheet stays open, fields intact
    }
    const spawnedId = result.created;
    // The promote endpoint takes no deps, so declared blockers are chained onto
    // the spawned task (create's create-then-depend seam). A partial failure —
    // task created, deps didn't attach — is surfaced honestly, the id still named.
    let depsFailed = false;
    if (spawnedId !== undefined && type === 'task' && deps.length > 0) {
      try {
        await depend.mutateAsync({ id: spawnedId, on: deps.map((d) => d.id) });
      } catch {
        depsFailed = true; // the hook toasts the raw cause; we add the honest recap
      }
    }
    if (depsFailed) {
      toast.error(
        `Promoted ${promote.seedId} → ${spawnedId}, but its dependencies didn't attach — add them on the task.`,
      );
    } else {
      toast.success(
        spawnedId !== undefined
          ? `Promoted ${promote.seedId} → ${spawnedId}`
          : `Promoted ${promote.seedId}`,
      );
    }
    if (openAfter && spawnedId !== undefined) {
      onOpenNode?.(spawnedId);
    }
    onOpenChange(false);
  }

  // Footer labels — a helper each to keep the JSX free of nested ternaries.
  function openActionLabel(): string {
    if (promote !== undefined) {
      return 'Promote & open';
    }
    return created !== null ? 'Retry deps & open' : 'Create & open';
  }
  function submitActionLabel(): string {
    if (promote !== undefined) {
      return 'Promote ↵';
    }
    return created !== null ? 'Retry deps ↵' : 'Create ↵';
  }

  function resetForNext() {
    setTitle('');
    setDescription('');
    setDeps([]);
    setDepSearch('');
    setDepQ('');
    setPriority('');
    setSize('');
    setTagsText('');
    setTagEntryOpen(false);
    titleRef.current?.focus();
  }

  async function handleCreate(openAfter: boolean) {
    if (!canCreate) {
      return;
    }
    let node: WireNode;
    if (created !== null) {
      // A prior submit already created this node and only the depend failed —
      // retry the attach against it; never re-create (a duplicate node).
      node = created;
    } else {
      try {
        node = await create.mutateAsync(buildInput());
      } catch {
        return; // toasted by the hook; the sheet stays open, nothing was written
      }
    }
    if (type === 'task' && deps.length > 0) {
      try {
        await depend.mutateAsync({ id: node.id, on: deps.map((d) => d.id) });
      } catch {
        // Create landed, depend failed — accepted non-atomicity: the hook
        // toasts the error and the sheet stays open in a retry-deps posture
        // pinned to the created node (visible + linked below the fields).
        setCreated(node);
        return;
      }
    }
    setCreated(null);
    if (openAfter) {
      onOpenNode?.(node.id);
      onOpenChange(false);
      return;
    }
    if (createAnother) {
      resetForNext();
    } else {
      onOpenChange(false);
    }
  }

  function pickDep(n: WireNode | undefined) {
    if (n === undefined) {
      return;
    }
    setDeps((d) => [...d, n]);
    setDepSearch('');
    setDepQ('');
    setDepActive(0);
  }

  function handleDepKey(e: KeyboardEvent<HTMLInputElement>) {
    if (!depListOpen || depOptions.length === 0) {
      // Enter mid-search must not fire Create with a half-typed dependency.
      if (e.key === 'Enter' && depSearch.trim() !== '') {
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setDepActive((i) => Math.min(i + 1, depOptions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setDepActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickDep(depActiveOption);
    }
  }

  return (
    <SheetContent
      aria-describedby={undefined}
      initialFocus={titleRef}
      className="border-line-bright bg-well-850"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void (promote !== undefined ? handlePromote(false) : handleCreate(false));
        }}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-[18px]"
      >
        {/* ── header: NEW · type selector · esc hint ─────────────────────── */}
        <SheetTitle className="sr-only">
          {promote !== undefined ? 'Promote seed' : 'New work item'}
        </SheetTitle>
        {/* Retry posture (node created, deps pending) freezes everything the
            already-created node can no longer absorb — only DEPENDS ON and the
            footer stay live. */}
        <fieldset
          disabled={created !== null}
          className="flex min-w-0 flex-col gap-3.5 disabled:opacity-40"
        >
          <header className="flex flex-wrap items-center gap-2.5">
            {headerSlot ?? <span className="microlabel text-accent-foreground">New</span>}
            {/* A seed germinates into a task — the type is fixed, so the selector is
                hidden in promote mode (the type stays `task`, its initial value). */}
            {promote === undefined && (
              <SegmentedControl
                options={TYPE_OPTIONS}
                value={type}
                onChange={setType}
                ariaLabel="Type"
                className="rounded-full"
                segmentClassName="min-h-11 rounded-full px-3 text-mono-id tracking-normal normal-case sm:min-h-0"
              />
            )}
            <span aria-hidden className="ml-auto font-mono text-micro text-ink-ghost">
              esc
            </span>
          </header>

          {/* ── title — the accent-ringed lead field ───────────────────────── */}
          <input
            ref={titleRef}
            aria-label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="rounded-[10px] border border-accent/35 bg-well-900 px-3.5 py-3 text-card-mobile font-medium text-ink-bright caret-accent outline-none placeholder:text-ink-ghost focus-visible:border-accent/60"
          />

          {/* ── HOME — the type-governed legal-parent picker ───────────────── */}
          <div className="flex flex-col gap-1.5">
            <span id="authoring-home-label" className="microlabel text-ink-faint">
              Home
            </span>
            <div className="relative">
              <button
                type="button"
                aria-labelledby="authoring-home-label"
                aria-haspopup="listbox"
                aria-expanded={homeOpen}
                aria-controls="authoring-home-options"
                onClick={() => setHomeOpen((o) => !o)}
                className={cn(
                  FIELD_SHELL,
                  'flex w-full items-center gap-2 px-[13px] py-2.5 text-left transition-colors hover:border-line-bright focus-visible:outline-2 focus-visible:outline-accent',
                )}
              >
                <span className="shrink-0 font-mono text-mono-id text-ink-faint">
                  {projKey === '' ? '—' : projKey}
                </span>
                <span className="truncate text-meta font-medium text-ink-bright">
                  {projKey === '' ? 'No projects' : projTitle}
                </span>
                {type !== 'initiative' && (
                  <>
                    <span aria-hidden className="text-ink-ghost">
                      ›
                    </span>
                    <span className="truncate text-meta font-medium text-ink-bright">
                      {homesPending ? 'loading…' : (pickedHome?.label ?? 'No legal home')}
                    </span>
                    {pickedHome?.openEnded === true && (
                      <span
                        className="font-mono text-mono-id text-accent-foreground"
                        title="open-ended"
                      >
                        ∞
                      </span>
                    )}
                    {suggestedHome !== undefined && pickedHome?.id === suggestedHome.id && (
                      <span className="text-micro text-ink-ghost">
                        suggested — bug → standing home
                      </span>
                    )}
                  </>
                )}
                <span aria-hidden className="ml-auto text-ink-ghost">
                  ▾
                </span>
              </button>
              {homeOpen && (
                <>
                  {/* click-away scrim for the picker (below the listbox, above the sheet) */}
                  <button
                    type="button"
                    aria-hidden
                    tabIndex={-1}
                    onClick={() => setHomeOpen(false)}
                    className="fixed inset-0 z-10 cursor-default"
                  />
                  <div
                    id="authoring-home-options"
                    role="listbox"
                    aria-labelledby="authoring-home-label"
                    className="absolute inset-x-0 top-full z-20 mt-1 flex max-h-64 flex-col gap-px overflow-y-auto rounded-[9px] border border-line-bright bg-well-850 p-1 shadow-2xl light:shadow-menu"
                  >
                    {type === 'initiative' ? (
                      <HomeProjectOptions
                        projectItems={projectItems}
                        projKey={projKey}
                        onPick={(id) => {
                          setProjectPick(id);
                          setParentPick('');
                          setHomeOpen(false);
                        }}
                      />
                    ) : (
                      <>
                        {projectItems.length > 1 && (
                          <div className="flex flex-wrap items-center gap-1 border-b border-line px-1.5 pt-1 pb-1.5">
                            {projectItems.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => {
                                  setProjectPick(p.id);
                                  setParentPick('');
                                }}
                                className={cn(
                                  'rounded-full px-2 py-0.5 font-mono text-micro text-ink-dim inset-ring inset-ring-line transition-colors hover:text-ink',
                                  p.id === projKey &&
                                    'bg-accent/12 text-accent-foreground inset-ring-accent/24',
                                )}
                              >
                                {p.id}
                              </button>
                            ))}
                          </div>
                        )}
                        {homesPending && (
                          <p className="px-2 py-1.5 text-xs text-ink-faint">loading…</p>
                        )}
                        {!homesPending && homes.length === 0 && (
                          <p className="px-2 py-1.5 text-xs text-ink-faint">
                            No legal home in {projKey === '' ? 'this project' : projKey}.
                          </p>
                        )}
                        {homes.map((h) => (
                          <button
                            key={h.id}
                            type="button"
                            role="option"
                            aria-selected={h.id === effectiveParent}
                            onClick={() => {
                              setParentPick(h.id);
                              setHomeOpen(false);
                            }}
                            className={cn(
                              'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-meta text-ink transition-colors hover:bg-well-800 hover:text-ink-bright',
                              h.depth === 1 && 'pl-6',
                              h.id === effectiveParent && 'bg-accent/12 text-ink-bright',
                            )}
                          >
                            <span className="truncate">{h.label}</span>
                            {h.openEnded && (
                              <span
                                className="font-mono text-mono-id text-accent-foreground"
                                title="open-ended"
                              >
                                ∞
                              </span>
                            )}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── description — always visible, markdown ok ──────────────────── */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="authoring-description" className="microlabel text-ink-faint">
              Description
            </label>
            <textarea
              id="authoring-description"
              value={description}
              aria-busy={descriptionPending === true}
              placeholder={descriptionPending === true ? 'loading the seed body…' : undefined}
              onChange={(e) => {
                descriptionTouched.current = true;
                setDescription(e.target.value);
              }}
              className={cn(
                FIELD_SHELL,
                'min-h-16 resize-y px-[13px] py-[11px] text-meta leading-[1.65] text-ink caret-accent outline-none placeholder:text-ink-ghost focus-visible:border-accent/35',
              )}
            />
            <p className="text-tag text-ink-ghost">
              {descriptionPending === true ? 'loading the seed body…' : 'markdown ok'}
            </p>
          </div>
        </fieldset>

        {/* ── DEPENDS ON — chip field + task search (tasks only) ─────────── */}
        {/* Always-visible in create mode; a collapsed disclosure in promote mode
            (MMR-248) — the promote endpoint takes no deps, so declared blockers
            are chained onto the spawned task after it germinates. */}
        {type === 'task' && (
          <div className="flex flex-col gap-1.5">
            {promote === undefined ? (
              <label htmlFor="authoring-dep-search" className="microlabel text-ink-faint">
                Depends on
              </label>
            ) : (
              <button
                type="button"
                aria-expanded={depsOpen}
                onClick={() => setDepsOpen((o) => !o)}
                className="flex items-center gap-2 self-start rounded focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className="microlabel text-ink-faint">Depends on · optional</span>
                <span aria-hidden className="text-micro text-ink-ghost">
                  {depsOpen ? '⌃' : '⌄'}
                </span>
              </button>
            )}
            {(promote === undefined || depsOpen) && (
              <>
                <div className="relative">
                  <div
                    className={cn(
                      FIELD_SHELL,
                      'flex flex-wrap items-center gap-1.5 px-[11px] py-2',
                    )}
                  >
                    {deps.map((d) => (
                      <span
                        key={d.id}
                        className="inline-flex items-center gap-1.5 rounded-full bg-line/70 py-1 pr-1 pl-2.5 inset-ring inset-ring-line-bright"
                      >
                        <StatusDot status={d.status} className="size-[5px]" />
                        <span className="font-mono text-tag text-ink-faint">{d.id}</span>
                        <span className="max-w-48 truncate text-xs text-ink">{d.title}</span>
                        <button
                          type="button"
                          aria-label={`Remove dependency ${d.id}`}
                          onClick={() => setDeps((cur) => cur.filter((x) => x.id !== d.id))}
                          className="-my-2.5 flex min-h-11 min-w-11 items-center justify-center rounded-full text-ink-faint transition-colors hover:text-ink-bright sm:my-0 sm:min-h-0 sm:min-w-0 sm:px-1"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    <input
                      id="authoring-dep-search"
                      role="combobox"
                      aria-expanded={depListOpen}
                      aria-controls="authoring-dep-results"
                      aria-autocomplete="list"
                      aria-activedescendant={
                        depListOpen && depActiveOption !== undefined
                          ? depOptionDomId(depActiveOption.id)
                          : undefined
                      }
                      value={depSearch}
                      onChange={(e) => setDepSearch(e.target.value)}
                      onKeyDown={handleDepKey}
                      placeholder="search tasks…"
                      className="min-w-32 flex-1 bg-transparent text-xs text-ink caret-accent outline-none placeholder:text-ink-faint"
                    />
                  </div>
                  {depListOpen && (
                    <div
                      id="authoring-dep-results"
                      role="listbox"
                      aria-label="Matching tasks"
                      className="absolute inset-x-0 top-full z-20 mt-1 flex max-h-56 flex-col gap-px overflow-y-auto rounded-[9px] border border-line-bright bg-well-850 p-1 shadow-2xl light:shadow-menu"
                    >
                      {depQuery.isPending && (
                        <p className="px-2 py-1.5 text-xs text-ink-faint">searching…</p>
                      )}
                      {!depQuery.isPending && depOptions.length === 0 && (
                        <p className="px-2 py-1.5 text-xs text-ink-faint">No tasks match.</p>
                      )}
                      {depOptions.map((n, i) => (
                        <button
                          key={n.id}
                          id={depOptionDomId(n.id)}
                          type="button"
                          role="option"
                          aria-selected={i === depActive}
                          onClick={() => pickDep(n)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-well-800',
                            i === depActive && 'bg-well-800',
                          )}
                        >
                          <StatusDot status={n.status} className="size-[5px]" />
                          <span className="font-mono text-tag text-ink-faint">{n.id}</span>
                          <span className="truncate text-xs text-ink">{n.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-tag text-ink-ghost">{DEP_HELPER}</p>
              </>
            )}
          </div>
        )}

        {/* ── SIGNALS · OPTIONAL — collapsed disclosure ──────────────────── */}
        <fieldset
          disabled={created !== null}
          className="flex min-w-0 flex-col gap-2.5 border-t border-line pt-3 disabled:opacity-40"
        >
          <button
            type="button"
            aria-expanded={signalsOpen}
            onClick={() => setSignalsOpen((o) => !o)}
            className="flex items-center gap-2 self-start rounded focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="microlabel text-ink-faint">Signals · optional</span>
            <span aria-hidden className="text-micro text-ink-ghost">
              {signalsOpen ? '⌃' : '⌄'}
            </span>
          </button>
          {signalsOpen && (
            <div className="flex flex-col gap-2.5">
              {type === 'task' && (
                <>
                  <div role="group" aria-label="Priority" className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-tag text-ink-dim">priority</span>
                    <div className="flex flex-wrap gap-1">
                      {PRIORITY_VALUES.map((p) => (
                        <button
                          key={p}
                          type="button"
                          aria-pressed={priority === p}
                          onClick={() => setPriority((cur) => (cur === p ? '' : p))}
                          className={cn(
                            'min-h-11 rounded-full px-2.5 py-1 font-mono text-micro text-ink-dim inset-ring inset-ring-line transition-colors hover:text-ink sm:min-h-0',
                            priority === p && PRIORITY_WASH[p],
                          )}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div role="group" aria-label="Size" className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-tag text-ink-dim">size</span>
                    <div className="flex flex-wrap gap-1">
                      {SIZE_VALUES.map((s) => (
                        <button
                          key={s}
                          type="button"
                          aria-pressed={size === s}
                          title={s}
                          onClick={() => setSize((cur) => (cur === s ? '' : s))}
                          className={cn(
                            'min-h-11 rounded-full px-2.5 py-1 font-mono text-micro text-ink-dim inset-ring inset-ring-line transition-colors hover:text-ink sm:min-h-0',
                            size === s && 'bg-line text-ink-bright',
                          )}
                        >
                          {SIZE_GLYPH[s]}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {!tagEntryOpen &&
                  tags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-full bg-line/70 py-0.5 pr-1 pl-2 font-mono text-tag text-ink inset-ring inset-ring-line"
                    >
                      {t}
                      <button
                        type="button"
                        aria-label={`Remove tag ${t}`}
                        onClick={() => setTagsText(tags.filter((x) => x !== t).join(', '))}
                        className="-my-2.5 flex min-h-11 min-w-11 items-center justify-center rounded-full text-ink-faint transition-colors hover:text-ink-bright sm:my-0 sm:min-h-0 sm:min-w-0 sm:px-1"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                {tagEntryOpen ? (
                  <input
                    aria-label="Tags"
                    // autofocus lands on the just-revealed entry, not sheet-open
                    // oxlint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    onBlur={() => setTagEntryOpen(false)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        setTagEntryOpen(false);
                      }
                    }}
                    placeholder="comma-separated tags"
                    className={cn(
                      FIELD_SHELL,
                      'px-2 py-1 font-mono text-tag text-ink outline-none',
                    )}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setTagEntryOpen(true)}
                    className="min-h-11 rounded-full border border-dashed border-line-bright px-2.5 py-1 font-mono text-micro text-ink-dim transition-colors hover:text-ink sm:min-h-0"
                  >
                    + tag
                  </button>
                )}
              </div>
            </div>
          )}
        </fieldset>

        {/* ── retry posture — the created node stays visible + linked ────── */}
        {created !== null && (
          <p role="status" className={cn(FIELD_SHELL, 'px-3 py-2 text-xs text-ink')}>
            <span className="font-mono text-tag text-ink-faint">{created.id}</span> created —
            dependencies not yet attached.
            {onOpenNode !== undefined && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => {
                    onOpenNode(created.id);
                    onOpenChange(false);
                  }}
                  className="rounded text-accent-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  open it
                </button>
              </>
            )}
          </p>
        )}

        {/* ── provenance contract (promote only) — the link-back verdict pact ─ */}
        {promote !== undefined && (
          <p className="rounded-[9px] bg-accent/5 px-[13px] py-2.5 text-meta leading-[1.5] text-ink-dim inset-ring inset-ring-accent/18">
            The task links back to{' '}
            <span className="font-mono text-mono-id text-accent-foreground">{promote.seedId}</span>;
            when it settles, the seed surfaces as ready to resolve — your verdict, never
            auto-closed.
          </p>
        )}

        {/* ── footer — promote copy + actions, or the create-mode controls ──── */}
        <footer className="mt-auto flex flex-wrap items-center gap-2.5 border-t border-line pt-3.5">
          {promote !== undefined ? (
            <span className="text-tag text-ink-dim">
              seed stays in the queue as <i>promoted</i>
            </span>
          ) : (
            <label className="flex items-center gap-2 text-tag text-ink-dim">
              <input
                type="checkbox"
                checked={createAnother}
                onChange={(e) => setCreateAnother(e.target.checked)}
                className="size-[13px] rounded-[4px] accent-accent"
              />
              create another
            </label>
          )}
          <div className="ml-auto flex items-center gap-2">
            <ActionButton
              size="sm"
              variant="outline"
              disabled={!canCreate}
              onClick={() =>
                void (promote !== undefined ? handlePromote(true) : handleCreate(true))
              }
              className="min-h-11 sm:min-h-0"
            >
              {openActionLabel()}
            </ActionButton>
            <ActionButton
              size="sm"
              type="submit"
              disabled={!canCreate}
              className="min-h-11 font-bold sm:min-h-0"
            >
              {submitActionLabel()}
            </ActionButton>
          </div>
        </footer>
      </form>
    </SheetContent>
  );
}

/** The initiative case: the home IS a project — the picker collapses to project rows. */
function HomeProjectOptions({
  projectItems,
  projKey,
  onPick,
}: {
  projectItems: WireNode[];
  projKey: string;
  onPick: (id: string) => void;
}) {
  if (projectItems.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-ink-faint">No projects yet.</p>;
  }
  return (
    <>
      {projectItems.map((p) => (
        <button
          key={p.id}
          type="button"
          role="option"
          aria-selected={p.id === projKey}
          onClick={() => onPick(p.id)}
          className={cn(
            'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-meta text-ink transition-colors hover:bg-well-800 hover:text-ink-bright',
            p.id === projKey && 'bg-accent/12 text-ink-bright',
          )}
        >
          <span className="font-mono text-mono-id text-ink-faint">{p.id}</span>
          <span className="truncate">{p.title}</span>
        </button>
      ))}
    </>
  );
}
