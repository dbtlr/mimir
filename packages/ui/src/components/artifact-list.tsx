import { Link } from '@tanstack/react-router';

import type { WireArtifactSummary } from '../api/types';
import { groupByDay, kindsOf } from '../lib/artifacts';
import { artifactLink, bareIdRedirect } from '../lib/record-url';
import { BrowserEmpty, BrowserGroup, BrowserRow } from './browser-list';

/** How many attached records a row names before folding the rest into `+N`. */
const MAX_LINKS = 3;

/** A kind tag beside the title: mono, small, a dim inset ring. */
function KindChip({ kind }: { kind: string }) {
  return (
    <span className="rounded-full px-2 py-px font-mono text-mono-id text-ink-dim inset-ring inset-ring-line-bright">
      {kind}
    </span>
  );
}

/**
 * The records an artifact is attached to — `on MMR-450, MMR-453` — each id a
 * link to its page. The links sit above the row's stretched title link
 * (`relative z-10`) so they stay clickable; a record id the router cannot
 * place reads as plain text. More than three fold into `+N`.
 */
function AttachedTo({ links }: { links: string[] }) {
  const shown = links.slice(0, MAX_LINKS);
  const more = links.length - shown.length;
  return (
    <span>
      on{' '}
      {shown.map((id, i) => {
        const target = bareIdRedirect(id);
        return (
          <span key={id}>
            {i > 0 && ', '}
            {target === undefined ? (
              <span className="font-mono">{id}</span>
            ) : (
              <Link {...target} className="relative z-10 font-mono hover:text-ink hover:underline">
                {id}
              </Link>
            )}
          </span>
        );
      })}
      {more > 0 && <span> +{more}</span>}
    </span>
  );
}

/**
 * The artifact browser's rows (MMR-454, "Browsers C"): grouped under a local
 * day header, newest first. Each row links to the artifact's own page, with
 * its kind chip(s) after the title, its summary as the lede, and the records
 * it is attached to as the meta line.
 */
export function ArtifactList({ items }: { items: WireArtifactSummary[] }) {
  if (items.length === 0) {
    return <BrowserEmpty>No artifacts match.</BrowserEmpty>;
  }
  return (
    <>
      {groupByDay(items).map((group) => (
        <BrowserGroup key={group.key} label={group.label}>
          {group.items.map((a) => (
            <BrowserRow
              key={a.id}
              to={artifactLink(a.id)}
              id={a.id}
              title={a.title}
              afterTitle={kindsOf(a.tags).map((kind) => (
                <KindChip key={kind} kind={kind} />
              ))}
              lede={a.summary}
              meta={a.links.length > 0 ? <AttachedTo links={a.links} /> : undefined}
            />
          ))}
        </BrowserGroup>
      ))}
    </>
  );
}
