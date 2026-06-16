import { queryOptions } from "@tanstack/react-query";
import { apiGet } from "./client";
import type {
  Collection,
  WireAnnotation,
  WireArtifactDetail,
  WireArtifactSummary,
  WireNode,
  WireTreeNode,
} from "./types";

/**
 * Every read the console makes, as shared `queryOptions`. Polling is the
 * liveness model (ADR 0013 — websockets deferred): ~10s while the document is
 * visible; TanStack Query pauses interval refetches while hidden and refetches
 * on reconnect/focus by default.
 */
export const POLL_MS = 10_000;

/** Fleet: every project with its rollup distribution riding along. */
export const projectsQuery = queryOptions({
  queryKey: ["projects"],
  queryFn: () => apiGet<Collection<WireNode>>("/api/projects"),
});

/** Attention strip: every in-flight task, portfolio-wide. */
export const inFlightQuery = queryOptions({
  queryKey: ["nodes", "attention", "in_progress"],
  queryFn: () => apiGet<Collection<WireNode>>("/api/nodes?type=task&status=in_progress"),
});

/** Attention strip: externally blocked tasks, portfolio-wide. */
export const blockedQuery = queryOptions({
  queryKey: ["nodes", "attention", "blocked"],
  queryFn: () => apiGet<Collection<WireNode>>("/api/nodes?type=task&status=blocked"),
});

/** Attention strip: tasks the stale verdict flags, portfolio-wide. */
export const staleQuery = queryOptions({
  queryKey: ["nodes", "attention", "stale"],
  queryFn: () => apiGet<Collection<WireNode>>("/api/nodes?type=task&is=stale"),
});

/**
 * The board's live half: every non-terminal task in the project, in rank
 * order — the API's array order IS rank (ADR 0007), so the Ready column
 * renders items exactly as received.
 */
export const boardLiveQuery = (key: string) =>
  queryOptions({
    queryKey: ["board", key, "live"],
    queryFn: () =>
      apiGet<Collection<WireNode>>(
        `/api/nodes?project=${encodeURIComponent(key)}&type=task&status=live`,
      ),
  });

/** The board's Done column source: completed tasks, newest completion first. */
export const boardDoneQuery = (key: string) =>
  queryOptions({
    queryKey: ["board", key, "done"],
    queryFn: () =>
      apiGet<Collection<WireNode>>(
        `/api/nodes?project=${encodeURIComponent(key)}&type=task&status=done&limit=200`,
      ),
  });

/** The tree lens: the whole project hierarchy, nested, rank-ordered. */
export const treeQuery = (key: string) =>
  queryOptions({
    queryKey: ["tree", key],
    queryFn: () => apiGet<WireTreeNode>(`/api/projects/${encodeURIComponent(key)}/tree`),
  });

/** One project record (status word + distribution for the board header). */
export const projectQuery = (key: string) =>
  queryOptions({
    queryKey: ["project", key],
    queryFn: () => apiGet<WireNode>(`/api/projects/${encodeURIComponent(key)}`),
  });

/** Drawer: the full node record (deps, tags, verdicts, artifact titles). */
export const nodeQuery = (id: string) =>
  queryOptions({
    queryKey: ["node", id],
    queryFn: () => apiGet<WireNode>(`/api/nodes/${encodeURIComponent(id)}`),
  });

/** Drawer: the node's freeform annotations (their own sub-resource). */
export const annotationsQuery = (id: string) =>
  queryOptions({
    queryKey: ["node", id, "annotations"],
    queryFn: () =>
      apiGet<Collection<WireAnnotation>>(`/api/nodes/${encodeURIComponent(id)}/annotations`),
  });

/** The artifact-browser filter set; every field is optional and composes AND. */
export interface ArtifactFilters {
  project?: string;
  tag?: string;
  q?: string;
  since?: string;
  before?: string;
}

/** Build the `/api/artifacts` query string from set filters (empty → ""). */
export function artifactParams(f: ArtifactFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== "") p.set(k, v);
  }
  return p.toString();
}

/** Portfolio artifact search — re-runs as filters change. */
export const artifactsQuery = (f: ArtifactFilters) =>
  queryOptions({
    queryKey: ["artifacts", f],
    queryFn: () => {
      const qs = artifactParams(f);
      return apiGet<Collection<WireArtifactSummary>>(`/api/artifacts${qs === "" ? "" : `?${qs}`}`);
    },
  });

/** One artifact with its body — the reader's source. */
export const artifactQuery = (id: string) =>
  queryOptions({
    queryKey: ["artifact", id],
    queryFn: () => apiGet<WireArtifactDetail>(`/api/artifacts/${encodeURIComponent(id)}`),
  });
