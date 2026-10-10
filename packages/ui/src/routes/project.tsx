import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';

import { isNotFound } from '../api/errors';
import { doctorQuery, projectQuery, treeQuery } from '../api/queries';
import type { WireNode } from '../api/types';
import { DirectionPanel } from '../components/direction-line';
import { DistributionBar } from '../components/distribution-bar';
import { FindingsChip } from '../components/findings-chip';
import { MarkdownBody } from '../components/markdown-body';
import { NewTaskButton } from '../components/new-task-button';
import { ArtifactLinks, ContentsSection, MetaRow } from '../components/node-record';
import { OfflineBanner } from '../components/offline-banner';
import { ProjectSettingsButton } from '../components/project-settings-button';
import { RailSection, RecordLayout } from '../components/record-layout';
import type { RailChip } from '../components/record-layout';
import { StatusBadge } from '../components/status-badge';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { nodeLink } from '../lib/record-url';
import { absoluteTime } from '../lib/time';
import { projectRoute } from '../router';
import { ProjectUnavailablePage } from './not-found';

/** The project's verbs: open its board, file new work, change its settings. */
function ActionsPanel({
  project,
  offline,
  onOpenNode,
}: {
  project: WireNode;
  offline: boolean;
  onOpenNode: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link
        to="/p/$key/board"
        params={{ key: project.id }}
        className="rounded border border-line bg-well-850 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-ink transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
      >
        Open board
      </Link>
      <NewTaskButton projectKey={project.id} offline={offline} onOpenNode={onOpenNode} />
      <ProjectSettingsButton project={project} offline={offline} />
    </div>
  );
}

function DetailsPanel({ project }: { project: WireNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      {project.distribution !== undefined && (
        <DistributionBar distribution={project.distribution} className="h-[5px] w-full" />
      )}
      {(project.tags?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {project.tags?.map((t) => (
            <Badge key={t.tag} variant="mono">
              {t.tag}
            </Badge>
          ))}
        </div>
      )}
      <dl className="flex flex-col gap-1">
        <MetaRow label="created">{absoluteTime(project.created_at)}</MetaRow>
        <MetaRow label="updated">{absoluteTime(project.updated_at)}</MetaRow>
      </dl>
    </div>
  );
}

/**
 * `/p/$key` — the project's own page (MMR-450): what it is, where it is
 * headed, and what it holds, on the shared record shell. The board is a view
 * one link away at `/p/$key/board`. The work page (MMR-439) replaces this
 * page's body with the six operator questions.
 */
export function ProjectPage() {
  const navigate = useNavigate();
  const { key } = projectRoute.useParams();
  const project = useQuery(projectQuery(key));
  // The tree lists the contents and the doctor read counts findings; a miss on
  // either only thins the page, so neither counts toward connectivity.
  const tree = useQuery(treeQuery(key));
  const health = useQuery(doctorQuery(key));
  const conn = connectivity([project]);
  const offline = conn.offline;

  // Archived-404 semantics (ADR 0015): the server answered, so this is not
  // "offline"; the project query keeps polling, so an unarchive heals.
  if (isNotFound(project.error)) {
    return <ProjectUnavailablePage projectKey={key} />;
  }

  const data = project.data;
  if (data === undefined) {
    return (
      <>
        <OfflineBanner {...conn} />
        <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-2 p-5">
          {project.isError ? (
            <p className="text-xs text-status-blocked">
              Unreachable, and nothing cached yet — is `mimir serve` running?
            </p>
          ) : (
            <>
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-7 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </>
          )}
        </main>
      </>
    );
  }

  const openNode = (id: string) => void navigate(nodeLink(id));
  const artifactCount = data.artifacts?.length ?? 0;

  const direction = (
    <DirectionPanel
      subject={{ key, kind: 'project' }}
      title={data.title}
      next={data.next}
      offline={offline}
    />
  );
  const actions = <ActionsPanel project={data} offline={offline} onOpenNode={openNode} />;
  const artifacts = <ArtifactLinks artifacts={data.artifacts} />;
  const details = <DetailsPanel project={data} />;

  const chips: RailChip[] = [
    { content: direction, label: 'Direction' },
    { content: actions, label: 'Actions' },
    { content: artifacts, count: artifactCount, label: 'Artifacts' },
    { content: details, label: 'Details' },
  ];

  const rail = (
    <>
      <RailSection label="Direction">{direction}</RailSection>
      <RailSection label="Actions">{actions}</RailSection>
      <RailSection label="Artifacts" count={artifactCount > 0 ? artifactCount : undefined}>
        {artifacts}
      </RailSection>
      <RailSection label="Details">{details}</RailSection>
    </>
  );

  const head = (
    <header className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-mono-id text-ink-faint">{key} · project</span>
        <StatusBadge status={data.status} pill />
        <FindingsChip projectKey={key} findings={health.data?.finding_total ?? 0} />
      </div>
      <h1 className="text-dossier leading-[1.35] font-bold tracking-[-0.01em] text-ink-bright md:text-header">
        {data.title}
      </h1>
    </header>
  );

  return (
    <>
      <OfflineBanner {...conn} />
      <RecordLayout
        head={head}
        rail={rail}
        chips={chips}
        className={cn(offline && 'offline-demoted')}
      >
        <section className="flex flex-col gap-1.5">
          <h2 className="microlabel border-b border-line pb-1.5 text-ink-faint">Description</h2>
          {data.description != null && data.description.trim() !== '' ? (
            <MarkdownBody breaks className="max-w-none">
              {data.description}
            </MarkdownBody>
          ) : (
            <p className="text-xs text-ink-faint">No description.</p>
          )}
        </section>
        <ContentsSection items={tree.data?.children} />
      </RecordLayout>
    </>
  );
}
