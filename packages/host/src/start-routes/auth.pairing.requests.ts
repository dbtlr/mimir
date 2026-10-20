import { createFileRoute } from '@tanstack/react-router';

import { postOnly } from '../server/pairing';
import { handlePairingRequest } from '../server/runtime';

export const Route = createFileRoute('/auth/pairing/requests')({
  server: { handlers: { ANY: postOnly, POST: ({ request }) => handlePairingRequest(request) } },
});
