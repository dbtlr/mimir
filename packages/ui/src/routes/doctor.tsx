import { useQuery } from '@tanstack/react-query';

import { doctorQuery } from '../api/queries';
import type { WireDoctorGroup } from '../api/types';
import { DoctorRecord } from '../components/doctor-record';
import { OfflineBanner } from '../components/offline-banner';
import { Skeleton } from '../components/ui/skeleton';
import { connectivity } from '../lib/connectivity';
import { ago } from '../lib/time';
import { doctorRoute } from '../router';

/**
 * `/doctor` — the Record-health panel (MMR-185, mocks 15a/23b): the dropped
 * records `mimir doctor` reports, grouped by file, each with its parse cause, the
 * offending source verbatim, and a nearest-legal hint. `?project` scopes to one
 * board (the header-chip deep link); unscoped spans every project (the overview /
 * attention surfacing). Strictly read-only — the only action anywhere is copying a
 * location. Amber throughout: the system is behaving; the records exist, the
 * console just can't read them. Never red.
 */

/** One file group: the mono path header + dropped/readable tally, then its records. */
function DoctorGroup({ group }: { group: WireDoctorGroup }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-well-850">
      <div className="flex items-center gap-2.5 border-b border-line bg-well-950 px-4 py-2.5">
        <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-dim">{group.path}</span>
        <span className="ml-auto shrink-0 text-tag text-ink-faint">
          {group.dropped} dropped · {group.readable} readable
        </span>
      </div>
      <div className="flex flex-col gap-4 px-4 py-3.5">
        {group.records.map((record) => (
          <DoctorRecord key={`${record.id}:${record.cause}`} record={record} />
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
  const total = facet?.dropped_total ?? 0;

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
              {total} {total === 1 ? 'record' : 'records'} dropped from view
            </span>
            <span className="text-xs text-ink-dim">
              — they exist in the files but the console cannot read them. Everything else renders
              normally.
            </span>
          </div>
        )}

        {facet !== undefined &&
          facet.groups.map((group) => <DoctorGroup key={group.project} group={group} />)}

        {facet !== undefined && total === 0 && (
          <div className="flex flex-col items-start gap-1.5 rounded-xl border border-line bg-well-850 px-4 py-5">
            <span className="text-sm font-medium text-ink-bright">No dropped records</span>
            <span className="text-xs text-ink-dim">
              Every record reads cleanly
              {project !== undefined && project !== '' ? ` in ${project}` : ''}. Damage would
              surface here as an amber group; there is none.
            </span>
          </div>
        )}
      </main>
    </>
  );
}
