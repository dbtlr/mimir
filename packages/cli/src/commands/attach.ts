/**
 * `attach [id]`: freeze a document as an artifact, linked to nodes of one
 * project. The body is a file (`--file`), else piped stdin.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders, PROJECT_KEY_PATTERN, projectNotFound } from '@mimir/contract';

import { MimirUsageError } from '../failures';
import { contentText, splitCsv, withListHint } from '../node-input';
import { asciiOption, tagOption, text, writeHints } from '../options';
import type { Ports } from '../ports';
import { okLine, presentationOf } from '../render/presentation';
import { noticeViews } from '../render/writes';
import type { Notice } from '../render/writes';

/** The last path segment of a file the body came from, which titles an artifact by default. */
const basename = (path: string): string => path.split('/').pop() ?? path;

export function attachCommand(ports: Ports) {
  return new Command('attach', {
    description: 'Attach a document to a project as an artifact, linked to nodes.',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'attach MMR-16 --file design.md',
            note: 'link a design to a task',
          },
          {
            command: 'cat notes.md | mimir attach --project MMR --title "Notes"',
            note: 'a project-level artifact from stdin',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('id', { description: 'A node to link (KEY-seq).' })
    .option('file', {
      description: 'The document. Read from stdin when omitted.',
      extensions: [helpInput({ placeholder: 'path' })],
      stdin: true,
      type: 'content',
    })
    .option('link', {
      description: 'More nodes to link. Repeat it, or separate with commas.',
      extensions: [helpInput({ placeholder: 'ids' })],
      multiple: true,
      type: 'string',
    })
    .option('project', text('The project it belongs to, when no node names it.', 'KEY'))
    .option('title', text("The artifact's title. Defaults to the file's name."))
    .option('summary', text('A one-line summary.'))
    .option('tag', tagOption)
    .option('ascii', asciiOption)
    .result<Notice>({ views: noticeViews })
    .views({ records: noticeViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const content = await contentText(options.file, host.terminal.stdin.isTTY);
      if (content.trim() === '') {
        throw new MimirUsageError('attach requires content (--file <path> or piped stdin)');
      }
      const links = [
        ...(args.id === undefined ? [] : [args.id]),
        ...options.link.flatMap((csv) => splitCsv(csv)),
      ];
      if (links.length === 0 && options.project === undefined) {
        throw new MimirUsageError('attach requires a link (KEY-seq) or --project <KEY>');
      }
      // A name not shaped like a key is a missing project, not a schema fault.
      if (options.project !== undefined && !PROJECT_KEY_PATTERN.test(options.project)) {
        throw projectNotFound(options.project);
      }
      const title =
        options.title ??
        (options.file?.path === undefined ? undefined : basename(options.file.path));
      if (title === undefined || title.trim() === '') {
        throw new MimirUsageError('attach from stdin requires --title <text>');
      }
      const engine = await ports.engine();
      const written = await withListHint(links, () =>
        engine.attach({
          content,
          links,
          project: options.project,
          summary: options.summary,
          tags: options.tag.length > 0 ? options.tag : undefined,
          title,
        }),
      );
      const { id } = intentEncoders.artifactDetail.parse(written);
      await out.results({
        ids: id,
        json: { artifact: { id } },
        line: okLine(presentationOf(host, options.ascii), `attached artifact ${id}`),
      });
    });
}
