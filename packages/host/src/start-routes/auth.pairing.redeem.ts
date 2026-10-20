import { createFileRoute } from '@tanstack/react-router';

import { handleRedeem } from '../server/runtime';

export const Route = createFileRoute('/auth/pairing/redeem')({
  server: {
    handlers: {
      ANY: () =>
        Response.json(
          { error: 'method not allowed' },
          {
            headers: { allow: 'POST', 'cache-control': 'no-store' },
            status: 405,
          },
        ),
      POST: ({ request }) => handleRedeem(request),
    },
  },
});
