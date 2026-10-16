FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
# Only this isolated build context enables the host authority module.
RUN printf 'export const MIMIR_HOST_AUTHORITY = true;\n' > packages/core/src/host-authority.ts
RUN bun run build:ui
RUN bun build packages/host/scripts/start.ts --target bun --external ../.output/server/index.mjs --outfile /app/scripts/host-start.mjs

FROM oven/bun:1.4.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MIMIR_DATA_DIR=/data \
    NITRO_HOST=0.0.0.0
COPY --from=build --chown=bun:bun /app/packages/host/.output ./.output
COPY --from=build --chown=bun:bun /app/scripts/host-start.mjs ./scripts/host-start.mjs
RUN mkdir /data && chown bun:bun /data
USER bun
VOLUME ["/data"]
EXPOSE 64647
CMD ["bun", "scripts/host-start.mjs"]
