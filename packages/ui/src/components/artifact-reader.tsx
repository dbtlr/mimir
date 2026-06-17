import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { artifactQuery } from "../api/queries";
import { absoluteTime } from "../lib/time";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";

/**
 * The shared artifact reader — renders a frozen markdown body plus metadata and
 * backlinks. Reached two ways (the browser's reader pane, and a task drawer's
 * artifact row); `onBack` is supplied by the host so Back is provenance-aware.
 */
export function ArtifactReader({
  id,
  onBack,
  onOpenNode,
}: {
  id: string;
  onBack: () => void;
  onOpenNode: (nodeId: string) => void;
}) {
  const artifact = useQuery(artifactQuery(id));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="artifact-reader">
      <header className="flex items-start gap-3 border-b border-line p-4 pb-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-2 py-1 text-[0.75rem] text-ink-dim transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
        >
          ← Back
        </button>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[0.6875rem] text-ink-dim">{id}</span>
            <Badge variant="outline">{artifact.data?.project ?? "…"}</Badge>
          </div>
          <h1 className="text-[0.9375rem] leading-snug font-semibold text-ink-bright">
            {artifact.data?.title ?? id}
          </h1>
          {artifact.data !== undefined && (
            <div className="flex flex-wrap items-center gap-1.5">
              {artifact.data.tags.map((t) => (
                <Badge key={t} variant="outline">
                  {t}
                </Badge>
              ))}
              <time className="font-mono text-[0.625rem] text-ink-faint">
                {absoluteTime(artifact.data.created_at)}
              </time>
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {artifact.isPending && <Skeleton className="h-40 w-full" />}
        {artifact.isError && (
          <p className="text-[0.75rem] text-status-blocked">Couldn't load {id}.</p>
        )}
        {artifact.data?.content !== undefined && (
          <article className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.data.content}</ReactMarkdown>
          </article>
        )}
        {artifact.data !== undefined && artifact.data.links.length > 0 && (
          <section className="mt-6 border-t border-line pt-3">
            <h2 className="microlabel mb-1.5 text-ink-faint">Linked</h2>
            <div className="flex flex-wrap gap-1.5">
              {artifact.data.links.map((nodeId) => (
                <button
                  key={nodeId}
                  type="button"
                  onClick={() => {
                    onOpenNode(nodeId);
                  }}
                  className="rounded-[3px] px-1.5 py-0.5 font-mono text-[0.6875rem] text-accent transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {nodeId}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
