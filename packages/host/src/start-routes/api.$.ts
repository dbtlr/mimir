import { createFileRoute } from '@tanstack/react-router';

import { handleApi } from '../server/runtime';

export const Route = createFileRoute('/api/$')({
  server: { handlers: { ANY: ({ request }) => handleApi(request) } },
});
