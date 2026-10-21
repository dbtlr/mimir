import { createFileRoute } from '@tanstack/react-router';

import { postOnly } from '../server/pairing';
import { handlePairingPoll } from '../server/runtime';

export const Route = createFileRoute('/auth/pairing/poll')({
  server: { handlers: { ANY: postOnly, POST: ({ request }) => handlePairingPoll(request) } },
});
