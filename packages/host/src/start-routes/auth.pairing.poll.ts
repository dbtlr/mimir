import { createFileRoute } from '@tanstack/react-router';

import { methodNotAllowed } from '../server/pairing';
import { handlePairingPoll } from '../server/runtime';

export const Route = createFileRoute('/auth/pairing/poll')({
  server: {
    handlers: {
      ANY: () => methodNotAllowed('POST'),
      POST: ({ request }) => handlePairingPoll(request),
    },
  },
});
