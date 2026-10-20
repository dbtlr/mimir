import { z } from 'zod';

const filed = z.object({ poll_secret: z.string(), user_code: z.string() });

/**
 * Pair a fixture device with a running host over HTTP: file a request, let
 * `approve` accept its code on the host side, then poll once for the token.
 */
export async function pairFixtureDevice(
  base: string,
  device: string,
  approve: (userCode: string) => Promise<unknown>,
): Promise<string> {
  const post = (path: string, body: unknown) =>
    fetch(`${base}/auth/pairing/${path}`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
  const response = await post('requests', { device });
  if (response.status !== 200) {
    throw new Error(`the pairing request was refused (${String(response.status)})`);
  }
  const request = filed.parse(await response.json());
  await approve(request.user_code);
  const answer = await post('poll', { poll_secret: request.poll_secret });
  return z
    .object({ device: z.literal(device), status: z.literal('approved'), token: z.string() })
    .parse(await answer.json()).token;
}
