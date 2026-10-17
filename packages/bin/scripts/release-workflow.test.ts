import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

const workflowPath = new URL('../../../.github/workflows/release.yml', import.meta.url);
const stepSchema = z.object({ id: z.string().optional(), run: z.string().optional() });
const workflowSchema = z.object({
  jobs: z.object({ 'host-image': z.object({ steps: z.array(stepSchema) }) }),
});

test.each([
  ['branch', 'feature/image', '0.26.0-next', ['ghcr.io/dbtlr/mimir-host:0.26.0-next']],
  [
    'tag',
    'v0.26.0-next.42',
    '0.26.0-next.42',
    ['ghcr.io/dbtlr/mimir-host:0.26.0-next.42', 'ghcr.io/dbtlr/mimir-host:next'],
  ],
  [
    'tag',
    'v0.26.0',
    '0.26.0',
    ['ghcr.io/dbtlr/mimir-host:0.26.0', 'ghcr.io/dbtlr/mimir-host:latest'],
  ],
])(
  'image metadata for %s %s matches the binary version and release channel',
  async (refType, refName, version, tags) => {
    const workflow = workflowSchema.parse(Bun.YAML.parse(await Bun.file(workflowPath).text()));
    const script = workflow.jobs['host-image'].steps.find((step) => step.id === 'metadata')?.run;
    expect(script).toBeDefined();
    if (script === undefined) {
      throw new Error('missing image metadata script');
    }
    const directory = await mkdtemp(join(tmpdir(), 'mimir-image-metadata-'));
    const output = join(directory, 'output');
    try {
      await mkdir(join(directory, 'packages/bin'), { recursive: true });
      await writeFile(join(directory, 'packages/bin/package.json'), '{"version":"0.26.0-next"}');
      const child = Bun.spawn(['bash', '-euo', 'pipefail', '-c', script], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_REF_NAME: refName,
          GITHUB_REF_TYPE: refType,
        },
        stderr: 'pipe',
        stdout: 'pipe',
      });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      expect(await readFile(output, 'utf8')).toBe(
        `version=${version}\ntags<<EOF\n${tags.join('\n')}\nEOF\n`,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);
