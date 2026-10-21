# The build output is platform-independent JavaScript, so build natively rather than under QEMU emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
# Only this isolated build context enables the host authority module.
RUN printf 'export const MIMIR_HOST_AUTHORITY = true;\n' > packages/core/src/host-authority.ts
ARG MIMIR_BUILD_VERSION
RUN if [ -n "$MIMIR_BUILD_VERSION" ]; then export MIMIR_BUILD_VERSION; else unset MIMIR_BUILD_VERSION; fi; bun run build:ui
RUN bun build packages/host/scripts/start.ts --target bun --external ../.output/server/index.mjs --outfile /app/scripts/host-start.mjs
# The operator CLI shares the host's authority build, so it opens the same store.
RUN bun build packages/host/src/admin/main.ts --target bun --outfile /app/scripts/mimir-host.mjs

FROM oven/bun:1.4.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MIMIR_DATA_DIR=/data \
    NITRO_HOST=0.0.0.0
COPY --from=build --chown=bun:bun /app/packages/host/.output ./.output
COPY --from=build --chown=bun:bun /app/scripts/host-start.mjs ./scripts/host-start.mjs
COPY --from=build --chown=bun:bun /app/scripts/mimir-host.mjs ./scripts/mimir-host.mjs
RUN mkdir /data && chown bun:bun /data \
    && printf '#!/bin/sh\nexec bun /app/scripts/mimir-host.mjs "$@"\n' > /usr/local/bin/mimir-host \
    && chmod 755 /usr/local/bin/mimir-host
USER bun
VOLUME ["/data"]
EXPOSE 64647
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:' + (process.env.MIMIR_PORT ?? '64647') + '/health', { signal: AbortSignal.timeout(2000) }); process.exit(response.ok && (await response.json()).status === 'ok' ? 0 : 1);"]
CMD ["bun", "scripts/host-start.mjs"]
