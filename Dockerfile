FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:ui

FROM oven/bun:1.4.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MIMIR_DATA_DIR=/data \
    NITRO_PORT=64647 \
    NITRO_HOST=0.0.0.0
COPY --from=build --chown=bun:bun /app/packages/host/.output ./.output
RUN mkdir /data && chown bun:bun /data
USER bun
VOLUME ["/data"]
EXPOSE 64647
CMD ["bun", ".output/server/index.mjs"]
