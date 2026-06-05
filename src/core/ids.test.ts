import { describe, expect, test } from "bun:test";
import { parseId, renderId } from "./ids";

describe("renderId", () => {
  test("joins key and seq as KEY-seq", () => {
    expect(renderId({ key: "MMR", seq: 16 })).toBe("MMR-16");
  });
});

describe("parseId", () => {
  test("parses a well-formed id", () => {
    expect(parseId("MMR-16")).toEqual({ key: "MMR", seq: 16 });
    expect(parseId("AB-1")).toEqual({ key: "AB", seq: 1 });
  });

  test("rejects malformed ids", () => {
    expect(parseId("mmr-16")).toBeNull(); // lowercase key
    expect(parseId("MMR16")).toBeNull(); // no separator
    expect(parseId("MMR-")).toBeNull(); // no seq
    expect(parseId("TOOLONG-1")).toBeNull(); // key length > 4
    expect(parseId("M-1")).toBeNull(); // key length < 2
    expect(parseId("MMR-1x")).toBeNull(); // non-numeric seq
  });

  test("round-trips with renderId", () => {
    const ref = { key: "WXYZ", seq: 4096 };
    expect(parseId(renderId(ref))).toEqual(ref);
  });
});
