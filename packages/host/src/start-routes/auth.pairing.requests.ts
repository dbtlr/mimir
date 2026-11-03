import { createFileRoute } from '@tanstack/react-router';

import { methodNotAllowed } from '../server/pairing';
import { handlePairingRequest } from '../server/runtime';

export const Route = createFileRoute('/auth/pairing/requests')({
  server: {
    handlers: {
      ANY: () => methodNotAllowed('POST'),
      POST: ({ request }) => handlePairingRequest(request),
    },
  },
});
