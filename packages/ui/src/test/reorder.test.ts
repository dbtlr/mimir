import { describe, expect, test } from "vitest";
import { reorderArgs } from "../lib/reorder";

const ids = ["A", "B", "C", "D"];

describe("reorderArgs", () => {
  test("dragging down lands after the drop neighbor", () => {
    expect(reorderArgs("A", "C", ids)).toEqual({ after: "C" });
  });

  test("dragging up lands before the drop neighbor", () => {
    expect(reorderArgs("D", "B", ids)).toEqual({ before: "B" });
  });

  test("dropping onto itself is a no-op", () => {
    expect(reorderArgs("B", "B", ids)).toBeNull();
  });

  test("unknown ids are a no-op", () => {
    expect(reorderArgs("A", "Z", ids)).toBeNull();
    expect(reorderArgs("Z", "A", ids)).toBeNull();
  });
});
