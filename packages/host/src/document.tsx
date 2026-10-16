import { HeadContent, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { WELL_900 } from './lib/theme-colors';

import stylesheet from './styles.css?url';

const themeScript = `(function(){try{var s=localStorage.getItem('mimir-theme');document.documentElement.dataset.theme=s==='light'||s==='dark'?s:window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}catch(e){}})()`;

/** Start prerenders only this data-free document in SPA mode. */
export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <meta name="theme-color" content={WELL_900.dark} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="icon" type="image/svg+xml" href="/icons/mimir.svg" />
        <link rel="apple-touch-icon" href="/icons/mimir-maskable.svg" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="stylesheet" href={stylesheet} />
        <title>Mimir</title>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
