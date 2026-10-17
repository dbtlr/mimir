import { hostConfig } from '../src/server/config';

// Nitro captures its port during module evaluation, before lifecycle plugins run.
try {
  // The serving launcher must never inherit Start's build-only store bypass.
  delete process.env.TSS_PRERENDERING;
  const config = await hostConfig();
  process.env.NITRO_PORT = String(config.port);
  process.env.NITRO_HOST = '0.0.0.0';
  const entry = new URL('../.output/server/index.mjs', import.meta.url);
  await import(entry.href);
} catch (error) {
  console.error(
    'host: startup refused:',
    error instanceof Error ? error.message : 'invalid configuration',
  );
  process.exit(1);
}
