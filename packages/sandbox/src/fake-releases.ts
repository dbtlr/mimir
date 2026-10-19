/**
 * A stand-in for GitHub's release downloads, for installer tests (MMR-554).
 * The installer script and self-update run unchanged: their requests reach
 * `https://github.com` through an HTTPS proxy that answers with a certificate
 * signed by a throwaway CA, which `curl` and Bun trust through their CA
 * variables. Only `github.com` is served. Test-only.
 */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer as createNet } from 'node:net';
import type { Server, Socket } from 'node:net';
import { join } from 'node:path';

const RELEASES = '/dbtlr/mimir/releases';

export type FakeReleases = {
  /** The variables a child needs to reach the fake through its proxy. */
  env: Record<string, string>;
  /** Publish one release's files under `releases/download/v<version>/`. */
  publish: (version: string, files: Record<string, Uint8Array | string>) => void;
  /** Point `releases/latest` at a stable release. */
  latest: (version: string) => void;
  /** List these releases in `releases.atom`, newest first. */
  feed: (versions: readonly string[]) => void;
  close: () => Promise<void>;
};

function openssl(args: string[], cwd: string): void {
  const run = spawnSync('openssl', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`openssl ${args.join(' ')} failed: ${run.stderr}`);
  }
}

/** A throwaway CA and a `github.com` certificate it signs, written under `dir`. */
function certificates(dir: string): { ca: string; cert: Buffer; key: Buffer } {
  const key = ['-newkey', 'rsa:2048', '-nodes'];
  const ca = ['-x509', '-days', '1', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=ca'];
  openssl(['req', ...key, ...ca], dir);
  const request = ['-keyout', 'site.key', '-out', 'site.csr', '-subj', '/CN=github.com'];
  openssl(['req', ...key, ...request], dir);
  writeFileSync(
    join(dir, 'site.ext'),
    'subjectAltName=DNS:github.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n',
  );
  const signing = ['-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1'];
  openssl(
    ['x509', '-req', '-in', 'site.csr', ...signing, '-extfile', 'site.ext', '-out', 'site.pem'],
    dir,
  );
  return {
    ca: join(dir, 'ca.pem'),
    cert: readFileSync(join(dir, 'site.pem')),
    key: readFileSync(join(dir, 'site.key')),
  };
}

const redirect = (location: string): Response =>
  new Response(null, { headers: { location }, status: 302 });

/** Listen on a loopback port the system picks, and answer it. */
async function listening(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

async function closed(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

/** Start the fake; `dir` holds its certificates. */
export async function fakeReleases(dir: string): Promise<FakeReleases> {
  const tls = certificates(dir);
  const files = new Map<string, Uint8Array | string>();
  let latest: string | undefined;
  // Bun's native server streams the release binaries (about a hundred
  // megabytes each) with backpressure, rather than node:https's compatibility
  // layer, under which a CI install stalled until it was killed.
  const site = Bun.serve({
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (latest !== undefined && path === `${RELEASES}/latest`) {
        return redirect(`https://github.com${RELEASES}/tag/v${latest}`);
      }
      if (latest !== undefined && path.startsWith(`${RELEASES}/latest/download/`)) {
        const file = path.slice(`${RELEASES}/latest/download/`.length);
        return redirect(`https://github.com${RELEASES}/download/v${latest}/${file}`);
      }
      const body = files.get(path);
      return body === undefined ? new Response('Not Found', { status: 404 }) : new Response(body);
    },
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: tls.cert, key: tls.key },
  });
  const sitePort = site.port ?? 0;
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };
  const proxy = createNet((client) => {
    track(client);
    // Read the whole CONNECT head with the client paused before tunnelling, so
    // no byte is read before the tunnel's pipes are in place.
    let head = Buffer.alloc(0);
    const onHead = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        return;
      }
      client.off('data', onHead);
      client.pause();
      const [method, target] = head.subarray(0, end).toString('latin1').split(' ');
      if (method !== 'CONNECT' || target !== 'github.com:443') {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      const early = head.subarray(end + 4);
      const upstream = connect(sitePort, '127.0.0.1', () => {
        if (early.length > 0) {
          upstream.write(early);
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(upstream).pipe(client);
      });
      track(upstream);
    };
    client.on('data', onHead);
  });
  const proxyUrl = `http://127.0.0.1:${String(await listening(proxy))}`;
  return {
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all([closed(proxy), site.stop(true)]);
    },
    env: {
      CURL_CA_BUNDLE: tls.ca,
      HTTPS_PROXY: proxyUrl,
      NODE_EXTRA_CA_CERTS: tls.ca,
      https_proxy: proxyUrl,
    },
    feed: (versions) => {
      const entries = versions.map(
        (version) =>
          `<entry><link rel="alternate" type="text/html" href="https://github.com${RELEASES}/tag/v${version}"/></entry>`,
      );
      files.set(`${RELEASES}.atom`, `<?xml version="1.0"?><feed>${entries.join('')}</feed>`);
    },
    latest: (version) => {
      latest = version;
    },
    publish: (version, published) => {
      for (const [name, body] of Object.entries(published)) {
        files.set(`${RELEASES}/download/v${version}/${name}`, body);
      }
    },
  };
}
