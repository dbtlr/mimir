/// <reference types="bun" />

export const PRECACHE_ASSERTION = 'complete app-shell coverage';

const dist = Bun.argv[2] ?? 'dist';
const workerPath = `${dist}/sw.js`;
const worker = await Bun.file(workerPath).text();
const manifestStart = worker.indexOf('precacheAndRoute([');
const manifestEnd = worker.indexOf('],{})', manifestStart);
if (manifestStart === -1 || manifestEnd === -1) {
  throw new Error(`could not find the precache manifest in ${workerPath}`);
}
const manifest = worker.slice(manifestStart, manifestEnd);
const urls = [...manifest.matchAll(/\{url:"([^"]+)"/g)].map((match) => match[1]);
if (urls.length === 0) {
  throw new Error('precache manifest contains no URLs');
}

const duplicates = [...new Set(urls.filter((url, index) => urls.indexOf(url) !== index))];
if (duplicates.length > 0) {
  throw new Error(`duplicate precache URLs: ${duplicates.join(', ')}`);
}

const required = [
  ['index HTML', (url: string) => url === 'index.html'],
  ['application JavaScript', (url: string) => url.startsWith('assets/') && url.endsWith('.js')],
  ['application CSS', (url: string) => url.startsWith('assets/') && url.endsWith('.css')],
  ['font', (url: string) => url.startsWith('assets/') && url.endsWith('.woff2')],
  ['web manifest', (url: string) => url === 'manifest.webmanifest'],
  ['standard icon', (url: string) => url === 'icons/mimir.svg'],
  ['maskable icon', (url: string) => url === 'icons/mimir-maskable.svg'],
] as const;
for (const [label, predicate] of required) {
  if (!urls.some(predicate)) {
    throw new Error(`precache manifest is missing ${label}`);
  }
}

const workboxMatch = /define\(\["\.\/([^"']*workbox[^"']*)"\]/.exec(worker);
if (
  workboxMatch?.[1] === undefined ||
  !(await Bun.file(`${dist}/${workboxMatch[1]}.js`).exists())
) {
  throw new Error('generated Workbox runtime is missing');
}
if (!worker.includes(String.raw`denylist:[/^\/api\//]`)) {
  throw new Error('service worker navigation fallback no longer excludes /api');
}

console.log(`precache: ${urls.length} unique URLs with ${PRECACHE_ASSERTION}`);
