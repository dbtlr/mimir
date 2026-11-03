import { createFileRoute } from '@tanstack/react-router';

import { getOnly } from '../server/pairing';
import { handleT3Callback } from '../server/runtime';

// Where T3 Code's OAuth flow returns the browser (ADR 0040; ADR 0038's 2026-11-03 addendum).
export const Route = createFileRoute('/auth/t3/callback')({
  server: { handlers: { ANY: getOnly, GET: ({ request }) => handleT3Callback(request) } },
});
