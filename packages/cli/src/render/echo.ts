/**
 * The echo of a lifecycle write: what the verb left behind. A task, phase, or
 * initiative echoes like any node write and a seed like any seed write; this
 * file adds the project and the dependents an archive freed, and composes the
 * three under one set of views.
 */
import type { View } from '@loomcli/core';

import { okLine, warnGlyph } from './presentation';
import type { Presentation } from './presentation';
import { seedEchoViews } from './seeds';
import type { SeedEcho } from './seeds';
import { compactJson, recordViews } from './views';
import { nodeEchoViews } from './writes';
import type { NodeEcho } from './writes';

/** A project a verb archived or restored, and the out-of-project tasks the archive freed. */
export type ProjectEcho = {
  archivedAt: string | null;
  key: string;
  presentation: Presentation;
  /** Out-of-project tasks an archive freed, named under the line. */
  released: readonly string[];
  /** The sentence after the glyph: `archived XX · superseded`. */
  signpost: string;
};

/** What a lifecycle verb echoes: a node, a seed, or a project. */
export type LifecycleEcho = NodeEcho | SeedEcho | ProjectEcho;

/** The line, then the dependents the archive freed; a project has no record. */
function projectStyled(echo: Readonly<ProjectEcho>): string {
  const head = okLine(echo.presentation, echo.signpost);
  if (echo.released.length === 0) {
    return head;
  }
  const glyph = warnGlyph(echo.presentation.plain);
  return `${head}\n${glyph} released ${String(echo.released.length)} dependent(s): ${echo.released.join(', ')}`;
}

/** A project echoes just its key and archive stamp, on one line. */
const projectJson = (echo: Readonly<ProjectEcho>): string =>
  compactJson({ project: { archived_at: echo.archivedAt, key: echo.key } });

const projectViews = recordViews<ProjectEcho>({
  ids: (echo) => echo.key,
  json: projectJson,
  records: projectStyled,
});

type Format = keyof typeof projectViews;

/** One format's view: the node, seed, or project view that matches the echo. */
function composed(format: Format): View<LifecycleEcho> {
  const node = nodeEchoViews[format];
  const seed = seedEchoViews[format];
  const project = projectViews[format];
  return {
    ...(node.mediaType === undefined ? {} : { mediaType: node.mediaType }),
    render: (echo, context) => {
      if ('node' in echo) {
        return node.render(echo, context);
      }
      return 'seed' in echo ? seed.render(echo, context) : project.render(echo, context);
    },
  };
}

export const echoViews = {
  ids: composed('ids'),
  json: composed('json'),
  jsonl: composed('jsonl'),
  records: composed('records'),
  table: composed('table'),
};
