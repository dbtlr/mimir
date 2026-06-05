import { describe, expect, test } from "bun:test";
import { HOLD_VALUES, LIFECYCLE_VALUES } from "../contract/enums";
import { type Distribution, interpret, tally, taskState } from "./state";

describe("taskState projection", () => {
  test("abandoned and done lifecycles win over any hold", () => {
    for (const hold of HOLD_VALUES) {
      expect(taskState({ lifecycle: "abandoned", hold, awaiting: false })).toBe("abandoned");
      expect(taskState({ lifecycle: "done", hold, awaiting: true })).toBe("done");
    }
  });

  test("a started-but-held task reads as the hold word, not in_progress", () => {
    expect(taskState({ lifecycle: "in_progress", hold: "blocked", awaiting: false })).toBe(
      "blocked",
    );
    expect(taskState({ lifecycle: "in_progress", hold: "parked", awaiting: false })).toBe("parked");
  });

  test("a held todo also reads as the hold word", () => {
    expect(taskState({ lifecycle: "todo", hold: "blocked", awaiting: true })).toBe("blocked");
    expect(taskState({ lifecycle: "todo", hold: "parked", awaiting: false })).toBe("parked");
  });

  test("in_progress + none is live work", () => {
    expect(taskState({ lifecycle: "in_progress", hold: "none", awaiting: false })).toBe(
      "in_progress",
    );
    // awaiting is ignored outside todo+none
    expect(taskState({ lifecycle: "in_progress", hold: "none", awaiting: true })).toBe(
      "in_progress",
    );
  });

  test("todo + none splits on readiness", () => {
    expect(taskState({ lifecycle: "todo", hold: "none", awaiting: true })).toBe("awaiting");
    expect(taskState({ lifecycle: "todo", hold: "none", awaiting: false })).toBe("ready");
  });

  test("every axis combination projects to exactly one valid word", () => {
    for (const lifecycle of LIFECYCLE_VALUES) {
      for (const hold of HOLD_VALUES) {
        for (const awaiting of [true, false]) {
          const word = taskState({ lifecycle, hold, awaiting });
          expect(word).not.toBe("new"); // tasks never project to the non-leaf word
        }
      }
    }
  });
});

describe("interpret cascade", () => {
  test("empty distribution is new (never vacuously done)", () => {
    expect(interpret({})).toBe("new");
    expect(interpret({ ready: 0 })).toBe("new");
  });

  test("live work beats everything", () => {
    expect(interpret({ in_progress: 1, ready: 5, blocked: 2, done: 9 })).toBe("in_progress");
  });

  test("ready beats awaiting/blocked/parked", () => {
    expect(interpret({ ready: 1, awaiting: 3, blocked: 2, parked: 1 })).toBe("ready");
  });

  test("the middle order is awaiting > blocked > parked", () => {
    expect(interpret({ awaiting: 1, blocked: 1, parked: 1 })).toBe("awaiting");
    expect(interpret({ blocked: 1, parked: 1 })).toBe("blocked");
    expect(interpret({ parked: 1, done: 4 })).toBe("parked");
  });

  test("new outranks terminal-only remainders", () => {
    expect(interpret({ new: 1, done: 2, abandoned: 1 })).toBe("new");
  });

  test("all-terminal is done if any done, else abandoned", () => {
    expect(interpret({ done: 3 })).toBe("done");
    expect(interpret({ done: 1, abandoned: 5 })).toBe("done");
    expect(interpret({ abandoned: 2 })).toBe("abandoned");
  });
});

describe("tally", () => {
  test("counts words into a distribution", () => {
    const dist: Distribution = tally(["ready", "ready", "done", "blocked"]);
    expect(dist).toEqual({ ready: 2, done: 1, blocked: 1 });
  });

  test("interpret(tally(...)) composes", () => {
    expect(interpret(tally(["done", "done", "ready"]))).toBe("ready");
  });
});
