import { useQuery } from '@tanstack/react-query';

import { doctorQuery } from '../api/queries';
import type { WireDoctorGroup } from '../api/types';
import { DoctorRecord } from '../components/doctor-record';
import { OfflineBanner } from '../components/offline-banner';
import { Skeleton } from '../components/ui/skeleton';
import { connectivity } from '../lib/connectivity';
import { findingCount } from '../lib/health';
import { ago } from '../lib/time';
import { doctorRoute } from '../router';

/**
 * `/doctor` — the Record-health panel (MMR-185): the findings `mimir doctor`
 * reports, grouped by project, each with its cause, the row's table and key, and
 * the evidence behind it. `?project` scopes to one board (the header-chip deep
 * link); unscoped spans every project (the overview / attention surfacing).
 * Strictly read-only — the only action anywhere is copying a location. Amber
 * throughout, never red. A finding is a record in an inconsistent state or an
 * unscoped scan's config warning, and each one's note names its own fix, so the
 * banner only counts.
 */

/** One project group: the mono key header + finding count, then its findings. */
function DoctorGroup({ group }: { group: WireDoctorGroup }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-well-850">
      <div className="flex items-center gap-2.5 border-b border-line bg-well-950 px-4 py-2.5">
        <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-dim">
          {group.project}
        </span>
        <span className="ml-auto shrink-0 text-tag text-ink-faint">
          {findingCount(group.finding_count)}
        </span>
      </div>
      <div className="flex flex-col gap-4 px-4 py-3.5">
        {/* id+cause alone collides (two dangling depends_on edges on one node);
            the index disambiguates — the list is read-only and re-fetched whole,
            so a positional key never fights a reorder. */}
        {group.records.map((record, i) => (
          <DoctorRecord key={`${record.id}:${record.cause}:${String(i)}`} record={record} />
        ))}
      </div>
    </div>
  );
}

export function DoctorPage() {
  const { project } = doctorRoute.useSearch();
  const doctor = useQuery(doctorQuery(project));
  const conn = connectivity([doctor]);
  const facet = doctor.data;
  const total = facet?.finding_total ?? 0;
  const unknownScope = facet?.scope?.matched_records === 0;

  return (
    <>
      <OfflineBanner {...conn} />
      <main className="mx-auto flex w-full max-w-[960px] min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">
            Record health
          </h1>
          <span className="font-mono text-[11.5px] text-ink-faint">
            {project !== undefined && project !== '' ? `${project} · ` : ''}mimir doctor
          </span>
          {facet !== undefined && (
            <span className="ml-auto text-tag text-ink-faint">
              last scan {ago(facet.scanned_at)} · rescans with poll
            </span>
          )}
        </div>

        {doctor.isPending && <Skeleton className="h-40" />}

        {doctor.isError && facet === undefined && (
          <p className="text-xs text-status-blocked">
            Unreachable, and nothing cached yet — is `mimir serve` running?
          </p>
        )}

        {facet !== undefined && total > 0 && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl bg-status-in-progress/[0.07] px-3.5 py-3 inset-ring inset-ring-status-in-progress/30">
            <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-status-in-progress" />
            <span className="text-sm font-semibold text-status-in-progress-foreground">
              {findingCount(total)}
            </span>
            <span className="text-xs text-ink-dim">
              — each one names what is wrong and how to fix it.
            </span>
          </div>
        )}

        {facet !== undefined &&
          facet.groups.map((group) => <DoctorGroup key={group.project} group={group} />)}

        {facet !== undefined && unknownScope && (
          <div className="flex flex-col items-start gap-1.5 rounded-xl border border-line bg-well-850 px-4 py-5">
            <span className="text-sm font-medium text-ink-bright">
              No project {facet.scope?.key}
            </span>
            <span className="text-xs text-ink-dim">
              The store holds no project with this key, so there is nothing to check.
            </span>
          </div>
        )}

        {facet !== undefined && total === 0 && !unknownScope && (
          <div className="flex flex-col items-start gap-1.5 rounded-xl border border-line bg-well-850 px-4 py-5">
            <span className="text-sm font-medium text-ink-bright">No findings</span>
            <span className="text-xs text-ink-dim">
              {project !== undefined && project !== ''
                ? `Every record is consistent in ${project}.`
                : 'Every record is consistent and the config is private to you.'}{' '}
              A finding would surface here as an amber group; there is none.
            </span>
          </div>
        )}
      </main>
    </>
  );
}
