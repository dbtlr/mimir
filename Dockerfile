# The build output is platform-independent JavaScript, so build natively rather than under QEMU emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build
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

# The Claude Code executable that agent runs spawn (ADR 0041, "The SDK is pinned"). It is the
# native binary Anthropic publishes as the platform package that @anthropic-ai/claude-agent-sdk
# names in its optionalDependencies, fetched from the npm registry
# (https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-<arch>). The version is the
# SDK's own pin in packages/host/package.json, and each checksum is the binary's SHA-256 from that
# SDK version's manifest.json ("claudeCodeVersion": "2.1.318"); agent-executable.test.ts keeps
# these pins equal to the installed SDK. Fetching runs natively, so only the checksum names the arch.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS claude-code
ARG TARGETARCH
ARG AGENT_SDK_VERSION=0.3.318
WORKDIR /claude-code
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) platform=linux-x64; checksum=708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd ;; \
      arm64) platform=linux-arm64; checksum=53a0d7e219d7b0804ecba5dbc002745e89f786cc946d2de85a6470d5b2d1fb06 ;; \
      *) echo "no Claude Code executable for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    url="https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-$platform/-/claude-agent-sdk-$platform-$AGENT_SDK_VERSION.tgz"; \
    bun -e 'const response = await fetch(process.argv.at(-1)); if (!response.ok) throw new Error(`HTTP ${response.status}`); await Bun.write("package.tgz", response);' "$url"; \
    tar -xzf package.tgz package/claude; \
    echo "$checksum  package/claude" | sha256sum --check --strict -; \
    install -m 755 package/claude /claude-code/claude; \
    rm -rf package package.tgz

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app
# The host syncs project clones with git before agent runs (ADR 0041).
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=claude-code /claude-code/claude /usr/local/bin/claude
ENV NODE_ENV=production \
    MIMIR_AGENT_CLAUDE_PATH=/usr/local/bin/claude \
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
