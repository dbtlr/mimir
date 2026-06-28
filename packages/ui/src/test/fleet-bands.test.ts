import { describe, expect, test } from "vitest";
import type { WireAttention } from "../api/types";
import { groupIntoBands } from "../lib/fleet-bands";
import { project } from "./fixtures";

/**
 * MMR-102 — the fleet's attention-band grouping. A pure transform from the
 * projects list (each carrying MMR-101's `attention` facet) to ordered,
 * non-empty bands, recency-sorted within each; degrades to a flat list when the
 * facet is absent (offline / pre-feature cache).
 */

function attn(band: WireAttention["band"], lastActivity: string, stale = false): WireAttention {
  return { band, last_activity: lastActivity, stale };
}

describe("groupIntoBands", () => {
  test("groups projects into the four bands in fixed highest-wins order", () => {
    const result = groupIntoBands([
      project({ id: "REST", attention: attn("at_rest", "2026-06-01T00:00:00.000Z") }),
      project({ id: "STUCK", attention: attn("needs_unsticking", "2026-06-01T00:00:00.000Z") }),
      project({ id: "REVIEW", attention: attn("awaiting_you", "2026-06-01T00:00:00.000Z") }),
      project({ id: "LIVE", attention: attn("live", "2026-06-01T00:00:00.000Z") }),
    ]);
    expect(result.mode).toBe("banded");
    if (result.mode !== "banded") return;
    expect(result.bands.map((b) => b.band)).toEqual([
      "awaiting_you",
      "live",
      "needs_unsticking",
      "at_rest",
    ]);
    expect(result.bands.map((b) => b.label)).toEqual([
      "Awaiting you",
      "Live",
      "Needs unsticking",
      "At rest",
    ]);
  });

  test("omits empty bands — no orphan headers", () => {
    const result = groupIntoBands([
      project({ id: "A", attention: attn("live", "2026-06-01T00:00:00.000Z") }),
      project({ id: "B", attention: attn("live", "2026-06-02T00:00:00.000Z") }),
    ]);
    expect(result.mode).toBe("banded");
    if (result.mode !== "banded") return;
    expect(result.bands).toHaveLength(1);
    expect(result.bands[0]?.band).toBe("live");
  });

  test("sorts within a band by last_activity descending (most recent first)", () => {
    const result = groupIntoBands([
      project({ id: "OLD", attention: attn("live", "2026-06-01T00:00:00.000Z") }),
      project({ id: "NEW", attention: attn("live", "2026-06-20T00:00:00.000Z") }),
      project({ id: "MID", attention: attn("live", "2026-06-10T00:00:00.000Z") }),
    ]);
    if (result.mode !== "banded") throw new Error("expected banded");
    expect(result.bands[0]?.projects.map((p) => p.id)).toEqual(["NEW", "MID", "OLD"]);
  });

  test("carries the going-cold (stale) flag through on the project's attention", () => {
    const result = groupIntoBands([
      project({ id: "COLD", attention: attn("live", "2026-06-01T00:00:00.000Z", true) }),
    ]);
    if (result.mode !== "banded") throw new Error("expected banded");
    expect(result.bands[0]?.projects[0]?.attention?.stale).toBe(true);
  });

  test("falls back to a flat list (input order) when any project lacks the facet", () => {
    const result = groupIntoBands([
      project({ id: "AAA", attention: attn("live", "2026-06-01T00:00:00.000Z") }),
      project({ id: "BBB" }), // no attention — degraded payload
    ]);
    expect(result.mode).toBe("flat");
    if (result.mode !== "flat") return;
    expect(result.projects.map((p) => p.id)).toEqual(["AAA", "BBB"]);
  });

  test("an empty fleet yields banded mode with no bands", () => {
    const result = groupIntoBands([]);
    expect(result.mode).toBe("banded");
    if (result.mode !== "banded") return;
    expect(result.bands).toHaveLength(0);
  });
});
