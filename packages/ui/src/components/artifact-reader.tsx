import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { artifactQuery, projectsQuery } from '../api/queries';
import type { WireArtifactLink } from '../api/types';
import { splitKindTags } from '../lib/artifacts';
import { cn } from '../lib/cn';
import { calendarDate, shortDate } from '../lib/time';
import { StatusDot } from './status-dot';
import { Skeleton } from './ui/skeleton';

/**
 * Inline code and code blocks are machine ground: the dark well stays dark in
 * BOTH themes (ADR 0019 §7 rule 4 — the inversion marks the boundary between
 * UI and record), so the values are literal, not theme tokens.
 */
const MACHINE_PROSE = cn(
  'prose-code:rounded-[4px] prose-code:bg-[#0B0F14] prose-code:px-1.5 prose-code:py-px',
  'prose-code:font-mono prose-code:text-xs prose-code:font-normal prose-code:text-[#B9C4CD]',
  'prose-code:before:content-none prose-code:after:content-none',
  'prose-pre:bg-[#0B0F14] prose-pre:text-[#B9C4CD]',
);

/** Route the typography plugin's palette through the Meridian ink tokens. */
const INK_PROSE = cn(
  '[--tw-prose-body:var(--color-ink)] [--tw-prose-invert-body:var(--color-ink)]',
  '[--tw-prose-headings:var(--color-ink-bright)] [--tw-prose-invert-headings:var(--color-ink-bright)]',
  '[--tw-prose-bold:var(--color-ink-bright)] [--tw-prose-invert-bold:var(--color-ink-bright)]',
  '[--tw-prose-links:var(--color-accent-foreground)] [--tw-prose-invert-links:var(--color-accent-foreground)]',
);

/** A provenance-rail / chip-row linked-node label — degrades with the facet. */
function linkName(link: WireArtifactLink): string {
  return link.title === undefined ? `Open ${link.id}` : `Open ${link.id} ${link.title}`;
}

/**
 * The frozen artifact reader (Meridian 16a/16b) — provenance back-link and a
 * `❄ FROZEN · IMMUTABLE` microlabel standing where an edit affordance would
 * be (there is deliberately none: the record is append-only), the markdown
 * body at a fixed 620px measure, and provenance on a recessed rail (desktop)
 * or a project-first chip row under the title (mobile — the owning project is
 * always the first chip, so an artifact with no linked nodes is never a dead
 * end). Reached two ways (the browser's reader pane, and a dossier's artifact
 * row); `onBack` is supplied by the host so Back is provenance-aware, and
 * `fromNode` names the node it returns to when set.
 */
export function ArtifactReader({
  id,
  fromNode,
  onBack,
  onOpenNode,
  onOpenProject,
}: {
  id: string;
  fromNode?: string | undefined;
  onBack: () => void;
  onOpenNode: (nodeId: string) => void;
  onOpenProject: (key: string) => void;
}) {
  const artifact = useQuery(artifactQuery(id));
  const projects = useQuery(projectsQuery);

  const data = artifact.data;
  const links = data?.links ?? [];
  const { kind, rest: tags } = splitKindTags(data?.tags ?? []);
  const projectTitle =
    data === undefined ? undefined : projects.data?.items.find((p) => p.id === data.project)?.title;

  let kindTagsLabel = 'Tags';
  if (kind !== undefined) {
    kindTagsLabel = tags.length > 0 ? 'Kind · tags' : 'Kind';
  }

  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_230px]"
      data-testid="artifact-reader"
    >
      <div className="flex min-h-0 flex-col gap-3.5 overflow-auto border-line px-4 py-[22px] md:border-r md:px-[30px]">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            className="rounded text-tag text-accent-foreground transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {fromNode === undefined ? '← Artifacts' : `← back to board · ${fromNode}`}
          </button>
          {data !== undefined && (
            <span className="ml-auto font-mono text-micro tracking-[0.1em] text-ink-faint">
              <span aria-hidden className="select-none">
                ❄{' '}
              </span>
              <span className="md:hidden">FROZEN {shortDate(data.created_at)}</span>
              <span className="max-md:hidden">
                FROZEN {calendarDate(data.created_at)} · IMMUTABLE
              </span>
            </span>
          )}
        </div>

        <h1 className="max-w-[620px] text-[1.1875rem] leading-[1.35] font-bold text-ink-bright">
          {data?.title ?? id}
        </h1>

        {/* Mobile provenance chips (16b): the owning project is ALWAYS the
            first chip — even with zero linked nodes there's a way back. */}
        {data !== undefined && (
          <div
            className="flex flex-wrap items-center gap-1.5 md:hidden"
            data-testid="provenance-chips"
          >
            <button
              type="button"
              onClick={() => {
                onOpenProject(data.project);
              }}
              aria-label={`Open project ${data.project}`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent/9 px-3.5 text-tag font-semibold text-accent-foreground inset-ring inset-ring-accent/20 transition-colors hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span className="font-mono">{data.project}</span>
              {projectTitle !== undefined && <span>{projectTitle}</span>}
              <span aria-hidden>→</span>
            </button>
            {links.map((link) => (
              <button
                key={link.id}
                type="button"
                onClick={() => {
                  onOpenNode(link.id);
                }}
                aria-label={linkName(link)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 font-mono text-tag text-ink-dim inset-ring inset-ring-line-bright transition-colors hover:bg-well-800 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                {link.status !== undefined && (
                  <StatusDot status={link.status} className="size-1.5" />
                )}
                {link.id}
              </button>
            ))}
          </div>
        )}

        {artifact.isPending && <Skeleton className="h-40 w-full max-w-[620px]" />}
        {artifact.isError && <p className="text-xs text-status-blocked">Couldn't load {id}.</p>}
        {data?.content !== undefined && (
          <article
            className={cn(
              'prose prose-sm dark:prose-invert max-w-[620px] text-[0.84375rem] leading-[1.75] max-md:text-sm',
              'prose-headings:text-[0.90625rem] prose-headings:font-semibold',
              INK_PROSE,
              MACHINE_PROSE,
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.content}</ReactMarkdown>
          </article>
        )}
      </div>

      {/* Desktop provenance rail (16a) on recessed ground. */}
      <aside
        aria-label="Provenance"
        className="hidden min-h-0 flex-col gap-4 overflow-auto bg-well-recessed px-[18px] py-[22px] md:flex"
      >
        {links.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h2 className="microlabel text-ink-faint">Linked nodes</h2>
            {links.map((link) => (
              <button
                key={link.id}
                type="button"
                onClick={() => {
                  onOpenNode(link.id);
                }}
                aria-label={linkName(link)}
                className="flex items-center gap-2 rounded-lg px-2.5 py-[7px] text-left inset-ring inset-ring-line-bright transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
              >
                {link.status !== undefined && (
                  <StatusDot status={link.status} className="size-1.5" />
                )}
                <span className="shrink-0 font-mono text-mono-id text-ink-faint">{link.id}</span>
                {link.title !== undefined && (
                  <span className="truncate text-[0.78125rem] text-ink">{link.title}</span>
                )}
              </button>
            ))}
          </section>
        )}

        {data !== undefined && (
          <section className="flex flex-col gap-1.5">
            <h2 className="microlabel text-ink-faint">Project</h2>
            <button
              type="button"
              onClick={() => {
                onOpenProject(data.project);
              }}
              aria-label={`Open project ${data.project}`}
              className="flex items-center gap-2 rounded-lg px-2.5 py-[7px] text-left inset-ring inset-ring-line-bright transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span className="shrink-0 font-mono text-mono-id text-ink-faint">{data.project}</span>
              {projectTitle !== undefined && (
                <span className="truncate text-[0.78125rem] text-ink">{projectTitle}</span>
              )}
              <span aria-hidden className="ml-auto text-ink-faint">
                →
              </span>
            </button>
          </section>
        )}

        {(kind !== undefined || tags.length > 0) && (
          <section className="flex flex-col gap-1.5">
            <h2 className="microlabel text-ink-faint">{kindTagsLabel}</h2>
            <div className="flex flex-wrap gap-1.5">
              {kind !== undefined && (
                <span className="rounded-full bg-well-800 px-2 py-0.5 font-mono text-micro text-ink-dim inset-ring inset-ring-line">
                  {kind}
                </span>
              )}
              {tags.map((t) => (
                <span
                  key={t}
                  className="max-w-32 truncate rounded-full bg-accent/9 px-2 py-0.5 font-mono text-micro text-accent-foreground inset-ring inset-ring-accent/20"
                >
                  {t}
                </span>
              ))}
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
