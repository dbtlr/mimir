import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../..', import.meta.url));

/** Capture Docker diagnostics without streaming the image build into test output. */
export async function docker(args: string[], timeout = 20_000, input?: string): Promise<string> {
  const child = Bun.spawn(['docker', ...args], {
    cwd: repository,
    stderr: 'pipe',
    stdin: input === undefined ? 'ignore' : new Response(input),
    stdout: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) {
      throw new Error(`docker ${args[0]} failed (${exit}): ${stderr.slice(-4000)}`);
    }
    return (args[0] === 'logs' ? `${stdout}\n${stderr}` : stdout).trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Run the image's own `mimir-host` inside `container`, with `input` on its stdin. */
export function hostCli(container: string, args: string[], input?: string): Promise<string> {
  const exec = input === undefined ? ['exec'] : ['exec', '-i'];
  return docker([...exec, container, 'mimir-host', ...args], 20_000, input);
}

/** Wait for a published container's `/health` and answer its loopback base URL. */
export async function ready(container: string, port = 64647): Promise<string> {
  const address = await docker(['port', container, `${port}/tcp`]);
  if (!/^127\.0\.0\.1:\d+$/.test(address)) {
    throw new Error(`expected one ephemeral loopback port, got ${JSON.stringify(address)}`);
  }
  const base = `http://${address}`;
  let health = 'no response';
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      const contentType = response.headers.get('content-type') ?? 'no content type';
      health = `${response.status} ${contentType}`;
      if (response.ok && contentType.includes('application/json')) {
        return base;
      }
    } catch {
      // Docker publishes the port before the host has opened its SQLite store.
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `container health did not become ready (${health}): ${await docker(['logs', container])}`,
  );
}
