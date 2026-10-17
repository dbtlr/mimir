import { createFileRoute } from '@tanstack/react-router';

import { handleTrpc } from '../server/runtime';

export const Route = createFileRoute('/trpc/$')({
  server: { handlers: { ANY: ({ request }) => handleTrpc(request) } },
});
