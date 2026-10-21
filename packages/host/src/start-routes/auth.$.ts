import { createFileRoute } from '@tanstack/react-router';

import { unknownAuthResponse } from '../server/pairing';

// Unknown /auth paths, the removed /auth/pairing/redeem included, answer a JSON 404.
export const Route = createFileRoute('/auth/$')({
  server: { handlers: { ANY: () => unknownAuthResponse() } },
});
