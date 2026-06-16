import { describe, expect, test } from "vitest";
import { artifactParams } from "../api/queries";

describe("artifactParams", () => {
  test("omits empty filters", () => {
    expect(artifactParams({})).toBe("");
  });

  test("encodes only the set filters", () => {
    const qs = artifactParams({ project: "MMR", q: "auth gate", tag: "kind:spec" });
    const p = new URLSearchParams(qs);
    expect(p.get("project")).toBe("MMR");
    expect(p.get("q")).toBe("auth gate");
    expect(p.get("tag")).toBe("kind:spec");
    expect(p.has("since")).toBe(false);
  });
});
