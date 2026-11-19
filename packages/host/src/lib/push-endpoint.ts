/*
 * Push endpoints as the host keeps them (ADR 0045, MMR-711). The host stores
 * each endpoint as its parsed URL's `href`, so a browser's own spelling, such
 * as an uppercase host, is compared after the same step.
 */

/** The endpoint as the host stores it; one that does not parse stays as written. */
export function hostEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).href;
  } catch {
    return endpoint;
  }
}

/** Whether two spellings name the same endpoint. */
export const sameEndpoint = (left: string, right: string): boolean =>
  hostEndpoint(left) === hostEndpoint(right);
