import type { Distribution } from "@mimir/contract";
import { describe, expect, test } from "vitest";
import { cardVitals } from "../lib/card-vitals";

/**
 * MMR-106 — the fleet card's five vitals, derived from the leaf-counts facet
 * (MMR-105) in a fixed order that mirrors the page's bands:
 * review → in prog → ready → await → blocked.
 */

describe("cardVitals", () => {
  test("returns the five vitals in the fixed band-mirroring order", () => {
    const counts: Distribution = {
      under_review: 2,
      in_progress: 3,
      ready: 4,
      awaiting: 1,
      blocked: 5,
    };
    expect(cardVitals(counts).map((v) => [v.word, v.count])).toEqual([
      ["under_review", 2],
      ["in_progress", 3],
      ["ready", 4],
      ["awaiting", 1],
      ["blocked", 5],
    ]);
  });

  test("missing buckets default to zero", () => {
    const vitals = cardVitals({ in_progress: 1 });
    expect(vitals.find((v) => v.word === "in_progress")?.count).toBe(1);
    expect(vitals.find((v) => v.word === "ready")?.count).toBe(0);
    expect(vitals.every((v) => typeof v.count === "number")).toBe(true);
  });

  test("ignores leaf buckets the card doesn't surface (parked/done/abandoned/new)", () => {
    const vitals = cardVitals({ ready: 2, done: 9, parked: 4, abandoned: 1 });
    expect(vitals).toHaveLength(5);
    expect(vitals.map((v) => v.word)).not.toContain("done");
    expect(vitals.map((v) => v.word)).not.toContain("parked");
  });

  test("an absent facet yields all-zero vitals", () => {
    expect(cardVitals(undefined).every((v) => v.count === 0)).toBe(true);
  });
});
