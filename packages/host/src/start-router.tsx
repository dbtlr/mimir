import { ClientOnly } from '@tanstack/react-router';

import { ConsoleProvider } from './console-root';
import { Document } from './document';
import { createConsoleRouter, consoleRoutes } from './router';
import { Shell } from './routes/shell';
import { routeTree as startRouteTree } from './routeTree.gen';

const serverRoutes = Object.values(startRouteTree.children ?? {});

function ClientConsole() {
  return (
    <ClientOnly>
      <Shell />
    </ClientOnly>
  );
}

/** Keep generated server routes outside the console's typed URL registry. */
export function getRouter() {
  // The generated tree's generic options omit this root-only Start option.
  Object.assign(startRouteTree.options, { shellComponent: Document });
  startRouteTree.update({ component: ClientConsole });
  startRouteTree.addChildren([...consoleRoutes, ...serverRoutes]);
  const router = createConsoleRouter();
  router.update({ Wrap: ConsoleProvider });
  return router;
}
