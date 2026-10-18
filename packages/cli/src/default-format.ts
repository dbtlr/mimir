/**
 * A Command's default view by destination: a command that declares
 * `defaultFormat({ terminal, piped })` renders `terminal` on a terminal and
 * `piped` otherwise. An explicit `--format` still wins, because the formatter's
 * middleware runs after this one and assigns only a supplied name.
 */
import { extension, plugin, readExtension } from '@loomcli/core';
import type { Middleware, Plugin } from '@loomcli/core';
import { z } from 'zod';

/** The view a Command renders by default on a terminal and when piped. */
export const defaultFormat = extension('@mimir/cli/default-format/command', {
  schema: z.object({ piped: z.string(), terminal: z.string() }),
  target: 'command',
});

const selectDefault: Middleware<Plugin> = async (context) => {
  const defaults = readExtension(context.command, defaultFormat);
  if (context.view !== null && defaults !== undefined) {
    context.view = context.host.terminal.stdout.isTTY ? defaults.terminal : defaults.piped;
  }
  await context.next();
};

/** Install ahead of the formatter, so `--format` overrides the destination default. */
export function defaultFormats(): Plugin {
  return plugin('@mimir/cli/default-format', {
    extensions: [defaultFormat],
    middleware: { activate: 'always', load: () => Promise.resolve({ default: selectDefault }) },
  });
}
