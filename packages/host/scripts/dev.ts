import { hostConfig } from '../src/server/config';

const config = await hostConfig();
const vite = new URL('../node_modules/vite/bin/vite.js', import.meta.url);
process.argv = [
  process.execPath,
  vite.pathname,
  '--port',
  String(config.port),
  ...process.argv.slice(2),
];
await import(vite.href);
