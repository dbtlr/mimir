import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The image installs the Claude Code executable that the pinned Agent SDK was
 * released with (ADR 0041, "The SDK is pinned"). The Dockerfile repeats the
 * SDK version and each binary's checksum; this keeps them equal to the SDK
 * that is installed, so moving the pin moves the image too.
 */

const sdkDirectory = dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')));
const dockerfile = join(import.meta.dir, '..', '..', '..', '..', 'Dockerfile');

type Manifest = { version: string; platforms: Record<string, { checksum: string }> };

test('the host pins the release-tested SDK and Claude Code pair exactly', async () => {
  const host = JSON.parse(
    await readFile(join(import.meta.dir, '..', '..', 'package.json'), 'utf8'),
  );
  expect(host.dependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.3.318');
  const sdk = JSON.parse(await readFile(join(sdkDirectory, 'package.json'), 'utf8'));
  expect(sdk.version).toBe('0.3.318');
  expect(sdk.claudeCodeVersion).toBe('2.1.318');
});

test("the image's executable pins match the installed SDK's manifest", async () => {
  const manifest: Manifest = JSON.parse(
    await readFile(join(sdkDirectory, 'manifest.json'), 'utf8'),
  );
  const sdk = JSON.parse(await readFile(join(sdkDirectory, 'package.json'), 'utf8'));
  const text = await readFile(dockerfile, 'utf8');
  expect(manifest.version).toBe(sdk.claudeCodeVersion);
  expect(text).toContain(`ARG AGENT_SDK_VERSION=${sdk.version}`);
  for (const [arch, platform] of [
    ['amd64', 'linux-x64'],
    ['arm64', 'linux-arm64'],
  ] as const) {
    const checksum = manifest.platforms[platform]?.checksum;
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(text).toContain(`${arch}) platform=${platform}; checksum=${checksum} ;;`);
  }
  expect(text).toContain('MIMIR_AGENT_CLAUDE_PATH=/usr/local/bin/claude');
});
