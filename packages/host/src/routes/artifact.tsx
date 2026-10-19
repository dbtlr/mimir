import type { EngineNode, EngineTree } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';

import { artifactQuery } from '../api/browse-queries';
import type { ArtifactRecord } from '../api/browse-queries';
import { isNotFound } from '../api/errors';
import { nodeQuery } from '../api/node-queries';
import { projectsQuery, treeQuery } from '../api/shell-queries';
import { MarkdownBody } from '../components/markdown-body';
import { MetaRow } from '../components/node-record';
import { OfflineBanner } from '../components/offline-banner';
import { RailSection, RecordLayout, RecordPending } from '../components/record-layout';
import type { RailChip } from '../components/record-layout';
import { StatusDot } from '../components/status-dot';
import { ActionButton } from '../components/ui/action-button';
import { sharedPathOf, subtreeOf } from '../lib/ancestry';
import { splitKindTags } from '../lib/artifacts';
import { copyText } from '../lib/clipboard';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { projectKeyOf } from '../lib/project-key';
import { useRememberRecord } from '../lib/recent-records';
import { artifactIdOf, artifactLink, artifactPath, nodeLink } from '../lib/record-url';
import { STATUS_META, recordStanding } from '../lib/status';
import { ago, calendarDate } from '../lib/time';
import { artifactRoute } from '../router';
import { NotFoundPage } from './not-found';

/**
 * `/p/$key/a$seq` — an artifact's own page (ADR 0013, v0.23 refinement;
 * MMR-452). The artifact reads under the work it is attached to: the path
 * runs through that record, a card for it sits above the frozen body, and
 * the rail lists its other artifacts. Attached to several records, the path
 * stops at the nearest container holding them all and the card lists each;
 * attached to none, the path is the project. A suffix off the artifact
 * grammar shows the not-found state without a lookup.
 */
export function ArtifactPage() {
  const { key, seq } = artifactRoute.useParams();
  const artifactId = artifactIdOf(key, seq);
  if (artifactId === undefined) {
    return (
      <NotFoundPage projectKey={key.toUpperCase()}>
        No record at /p/{key}/a{seq}.
      </NotFoundPage>
    );
  }
  return <ArtifactRecord key={artifactId} artifactId={artifactId} />;
}

const crumb =
  'rounded-sm font-mono text-tag wrap-anywhere text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent';

const row =
  'flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 text-xs text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent';

/** How many attached records show before the rest fold behind "Show all N". */
const ATTACHED_SHOWN = 5;

/** A linked record as the node read serves it: what its standing and row read. */
type LinkedNode = Pick<EngineNode, 'completedAt' | 'status' | 'title' | 'type' | 'updatedAt'>;

/**
 * An attached record: its id, plus the title and status the project tree adds
 * when it can place the record. Both are absent when it cannot (the link
 * degrades to its bare id).
 */
type AttachedLink = { id: string; title?: string; status?: EngineNode['status'] };

/** The number after an id's hyphen: `MMR-417` → 417. */
const seqOf = (id: string): number => Number(id.slice(id.indexOf('-') + 1));

/** Linked records in id-number order; the wire sorts them as text, putting MMR-10 before MMR-9. */
const byNumber = (links: readonly AttachedLink[]): AttachedLink[] =>
  links.toSorted((a, b) => seqOf(a.id) - seqOf(b.id));

/**
 * The attached records as the card lists them. The Engine names each by id;
 * the project tree, which the page reads for its path, adds the title and
 * status, and a record the tree cannot place keeps its bare id.
 */
function attachedLinks(ids: readonly string[], tree: EngineTree | undefined): AttachedLink[] {
  return ids.map((id) => {
    const node = tree === undefined ? undefined : subtreeOf(tree, id);
    return node === undefined ? { id } : { id, status: node.status, title: node.title };
  });
}

/** A linked record's standing: the loaded node's, or its status word alone. */
function linkStanding(link: AttachedLink, node: LinkedNode | undefined): string | undefined {
  if (node !== undefined) {
    return recordStanding(node);
  }
  return link.status === undefined ? undefined : STATUS_META[link.status].label.toLowerCase();
}

/** One attached record: its state, id, and title, linked to its page. */
function AttachedRow({ link, node }: { link: AttachedLink; node?: LinkedNode }) {
  const status = node?.status ?? link.status;
  const standing = linkStanding(link, node);
  return (
    <Link {...nodeLink(link.id)} className={row}>
      {status !== undefined && <StatusDot status={status} />}
      <span className="shrink-0 font-mono text-mono-id text-accent-foreground">{link.id}</span>
      <span className="min-w-0 flex-1 truncate">{node?.title ?? link.title}</span>
      {standing !== undefined && (
        <span className="shrink-0 font-mono text-mono-id text-ink-faint">{standing}</span>
      )}
    </Link>
  );
}

/**
 * The records the artifact is attached to, above its body. One record is the
 * work the artifact reads under; several are listed, folding past a handful.
 */
function AttachedCard({
  links,
  host,
}: {
  links: readonly AttachedLink[];
  host: LinkedNode | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const labelId = useId();
  const label = links.length === 1 ? 'Attached to' : `Attached to · ${String(links.length)}`;
  const shown = expanded ? links : links.slice(0, ATTACHED_SHOWN);
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="flex flex-col gap-1 rounded-lg bg-well-850 px-2.5 py-2 inset-ring inset-ring-line"
    >
      <h2 id={labelId} className="microlabel px-1 text-ink-faint">
        {label}
      </h2>
      <ul className="flex flex-col">
        {shown.map((link) => (
          <li key={link.id}>
            <AttachedRow link={link} node={links.length === 1 ? host : undefined} />
          </li>
        ))}
      </ul>
      {links.length > ATTACHED_SHOWN && (
        // One toggle that stays put, so keyboard focus survives the unfold.
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="self-start rounded-sm px-1 text-tag text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          {expanded ? 'Show fewer' : `Show all ${String(links.length)}`}
        </button>
      )}
    </div>
  );
}

/** The host record's artifacts, this one marked as the current page. */
function SiblingArtifacts({
  artifacts,
  currentId,
}: {
  artifacts: readonly { id: string; title: string }[];
  currentId: string;
}) {
  return (
    <ul className="flex flex-col">
      {artifacts.map((a) => (
        <li key={a.id}>
          <Link
            {...artifactLink(a.id)}
            aria-current={a.id === currentId ? 'page' : undefined}
            className={cn(row, 'aria-[current=page]:bg-well-800')}
          >
            <span className="shrink-0 font-mono text-mono-id text-ink-faint">
              {a.id.slice(a.id.indexOf('-') + 1)}
            </span>
            <span className="min-w-0 flex-1 truncate">{a.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Copy link, and the frozen body as a markdown download. */
function ActionsPanel({ artifact }: { artifact: ArtifactRecord }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <ActionButton
        size="sm"
        variant="outline"
        onClick={() =>
          void copyText(`${globalThis.location.origin}${artifactPath(artifact.id)}`, {
            copied: `Copied the link to ${artifact.id}`,
            failed: `Couldn't copy the link to ${artifact.id}.`,
          })
        }
      >
        Copy link
      </ActionButton>
      {artifact.content !== undefined && (
        <a
          href={`data:text/markdown;charset=utf-8,${encodeURIComponent(artifact.content)}`}
          download={`${artifact.id}.md`}
          className="inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-ink inset-ring inset-ring-line-bright transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
        >
          Download .md
        </a>
      )}
    </div>
  );
}

function DetailsPanel({
  artifact,
  projectTitle,
}: {
  artifact: ArtifactRecord;
  projectTitle: string | undefined;
}) {
  const { rest: tags } = splitKindTags(artifact.tags);
  return (
    <dl className="flex flex-col gap-1">
      <MetaRow label="Frozen">
        {calendarDate(artifact.createdAt)} · {ago(artifact.createdAt)}
      </MetaRow>
      <MetaRow label="Project">
        <Link to="/p/$key" params={{ key: artifact.project }} className={crumb}>
          {artifact.project}
          {projectTitle !== undefined && ` ${projectTitle}`}
        </Link>
      </MetaRow>
      {tags.length > 0 && <MetaRow label="Tags">{tags.join(' · ')}</MetaRow>}
      <MetaRow label="Link">{artifactPath(artifact.id)}</MetaRow>
    </dl>
  );
}

function ArtifactRecord({ artifactId }: { artifactId: string }) {
  const projectKey = projectKeyOf(artifactId);
  const artifact = useQuery(artifactQuery(artifactId));
  const projects = useQuery(projectsQuery);
  // The tree is the whole board, so it is read once rather than polled.
  const tree = useQuery({ ...treeQuery(projectKey), refetchInterval: false });
  const links = byNumber(attachedLinks(artifact.data?.links ?? [], tree.data));
  const hostId = links.length === 1 ? links[0]?.id : undefined;
  const host = useQuery({ ...nodeQuery(hostId ?? ''), enabled: hostId !== undefined });
  const conn = connectivity([artifact]);
  const data = artifact.data;
  useRememberRecord(
    data && { id: artifactId, kind: 'artifact', project: data.project, title: data.title },
  );

  if (isNotFound(artifact.error)) {
    return <NotFoundPage projectKey={projectKey}>No record {artifactId}.</NotFoundPage>;
  }
  if (data === undefined) {
    return (
      <>
        <OfflineBanner {...conn} />
        <RecordPending unreachable={artifact.isError} />
      </>
    );
  }

  const projectTitle = projects.data?.find((p) => p.id === data.project)?.title;
  const { kind } = splitKindTags(data.tags);
  const hostNode = hostId === undefined ? undefined : host.data;
  const siblings = hostNode?.artifacts ?? [];
  // The tree names the containers; until it answers, or if it cannot, a lone
  // linked record still heads the path on its own.
  const shared =
    tree.data === undefined
      ? undefined
      : sharedPathOf(
          tree.data,
          links.map((l) => l.id),
        );
  const crumbs =
    shared?.map((n) => ({ id: n.id, label: n.id === hostId ? n.id : n.title })) ??
    (hostId === undefined ? [] : [{ id: hostId, label: hostId }]);

  const actions = <ActionsPanel artifact={data} />;
  const details = <DetailsPanel artifact={data} projectTitle={projectTitle} />;
  const siblingList =
    hostId !== undefined && siblings.length > 0 ? (
      <SiblingArtifacts artifacts={siblings} currentId={artifactId} />
    ) : null;
  const siblingLabel = `${hostId ?? ''}'s artifacts`;
  const chips: RailChip[] = [
    ...(siblingList === null
      ? []
      : [{ content: siblingList, count: siblings.length, label: 'Artifacts' }]),
    { content: actions, label: 'Actions' },
    { content: details, label: 'Details' },
  ];
  const rail = (
    <>
      {siblingList !== null && (
        <RailSection label={siblingLabel} count={siblings.length}>
          {siblingList}
        </RailSection>
      )}
      <RailSection label="Actions">{actions}</RailSection>
      <RailSection label="Details">{details}</RailSection>
    </>
  );

  const head = (
    <header className="flex flex-col gap-1.5">
      <nav aria-label="Path" className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <Link to="/p/$key" params={{ key: data.project }} className={crumb}>
          {tree.data?.title ?? projectTitle ?? data.project}
        </Link>
        {crumbs.map((n) => (
          <span key={n.id} className="flex items-baseline gap-1.5">
            <span aria-hidden className="text-tag text-ink-faint">
              ›
            </span>
            <Link {...nodeLink(n.id)} className={crumb}>
              {n.label}
            </Link>
          </span>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-mono-id text-ink-faint">{artifactId} · artifact</span>
        {kind !== undefined && (
          <span className="rounded-full bg-well-800 px-2 py-0.5 font-mono text-micro text-ink-dim inset-ring inset-ring-line">
            {kind}
          </span>
        )}
        <span className="ml-auto font-mono text-micro tracking-[0.1em] text-ink-faint">
          <span aria-hidden className="select-none">
            ❄{' '}
          </span>
          Frozen {calendarDate(data.createdAt)}
        </span>
      </div>
      <h1 className="text-dossier leading-[1.35] font-bold tracking-[-0.01em] wrap-anywhere text-ink-bright md:text-header">
        {data.title}
      </h1>
      {data.summary !== undefined && (
        <p className="max-w-[68ch] text-meta leading-relaxed text-ink-dim">{data.summary}</p>
      )}
    </header>
  );

  return (
    <>
      <OfflineBanner {...conn} />
      <RecordLayout
        head={head}
        rail={rail}
        chips={chips}
        className={cn(conn.offline && 'offline-demoted')}
      >
        {links.length > 0 && <AttachedCard links={links} host={hostNode} />}
        {data.content !== undefined && (
          <MarkdownBody images className="max-w-[68ch]">
            {data.content}
          </MarkdownBody>
        )}
      </RecordLayout>
    </>
  );
}
