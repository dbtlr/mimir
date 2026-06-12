/**
 * The one fetch seam. Production is same-origin (the SPA is served by
 * `mimir serve` itself); `VITE_API_BASE` exists for the dev loop — `vite dev`
 * against a running `mimir serve`, which already reflects localhost CORS.
 */
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${String(res.status)}`);
  }
  return (await res.json()) as T;
}
