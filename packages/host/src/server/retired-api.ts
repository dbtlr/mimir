/**
 * The tombstone for the retired `/api` resource envelope (MMR-541). A probe or
 * an old installed console that still asks for `/api` must get a refusal it can
 * read, not the console's HTML shell with a 200. The host guard runs before this
 * route, and the service worker never answers `/api` with the shell.
 */
export function retiredApiResponse(): Response {
  return Response.json(
    {
      error: {
        code: 'gone',
        hint: 'read and write through /trpc, or reload the console to get the current build',
        message: '/api was retired; the host serves the console and the Engine at /trpc',
      },
    },
    { headers: { 'cache-control': 'no-store' }, status: 410 },
  );
}
