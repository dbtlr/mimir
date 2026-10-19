import { createFileRoute } from '@tanstack/react-router';

import { retiredApiResponse } from '../server/retired-api';

// Tombstone for the retired /api envelope: every method answers 410 gone.
export const Route = createFileRoute('/api/$')({
  server: { handlers: { ANY: () => retiredApiResponse() } },
});
