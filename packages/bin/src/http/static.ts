/**
 * Serving the embedded console (ADR 0013): the generated asset manifest maps
 * URL paths to Bun file-type imports — paths into `packages/ui/dist` in dev,
 * paths into the compiled binary's embedded files after `bun build --compile`.
 * Any non-/api GET miss falls back to `index.html` (the SPA owns its routes);
 * an empty manifest (no UI built) serves nothing and the caller 404s.
 */
export interface UiAsset {
  /** What `import ... with { type: "file" }` resolved to — feed it to `Bun.file`. */
  file: string;
  /** The `content-type` header value. */
  type: string;
  /** Vite content-hashed assets are immutable; the shell files are not. */
  immutable: boolean;
}

export type UiAssetMap = Readonly<Record<string, UiAsset>>;

const INDEX = '/index.html';

function assetResponse(asset: UiAsset): Response {
  return new Response(Bun.file(asset.file), {
    headers: {
      'content-type': asset.type,
      'cache-control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
}

/** The embedded-UI read: exact asset, or the SPA fallback; null = nothing to serve. */
export function uiResponse(pathname: string, assets: UiAssetMap): Response | null {
  const exact = assets[pathname === '/' ? INDEX : pathname];
  if (exact !== undefined) {
    return assetResponse(exact);
  }
  const index = assets[INDEX];
  return index === undefined ? null : assetResponse(index);
}
