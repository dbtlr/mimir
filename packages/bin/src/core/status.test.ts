import { describe, expect, test } from "bun:test";
import { HOLD_VALUES, LIFECYCLE_VALUES } from "@mimir/contract";
import { type Distribution, interpret, tally, taskStatus } from "./status";

describe("taskStatus projection", () => {
  test("abandoned and done lifecycles win over any hold", () => {
    for (const hold of HOLD_VALUES) {
      expect(taskStatus({ lifecycle: "abandoned", hold, awaiting: false })).toBe("abandoned");
      expect(taskStatus({ lifecycle: "done", hold, awaiting: true })).toBe("done");
    }
  });

  test("a started-but-held task reads as the hold word, not in_progress", () => {
    expect(taskStatus({ lifecycle: "in_progress", hold: "blocked", awaiting: false })).toBe(
      "blocked",
    );
    expect(taskStatus({ lifecycle: "in_progress", hold: "parked", awaiting: false })).toBe(
      "parked",
    );
  });

  test("a held todo also reads as the hold word", () => {
    expect(taskStatus({ lifecycle: "todo", hold: "blocked", awaiting: true })).toBe("blocked");
    expect(taskStatus({ lifecycle: "todo", hold: "parked", awaiting: false })).toBe("parked");
  });

  test("in_progress + none is live work", () => {
    expect(taskStatus({ lifecycle: "in_progress", hold: "none", awaiting: false })).toBe(
      "in_progress",
    );
    // awaiting is ignored outside todo+none
    expect(taskStatus({ lifecycle: "in_progress", hold: "none", awaiting: true })).toBe(
      "in_progress",
    );
  });

  test("todo + none splits on readiness", () => {
    expect(taskStatus({ lifecycle: "todo", hold: "none", awaiting: true })).toBe("awaiting");
    expect(taskStatus({ lifecycle: "todo", hold: "none", awaiting: false })).toBe("ready");
  });

  test("under_review + none reads as under_review (MMR-84)", () => {
    expect(taskStatus({ lifecycle: "under_review", hold: "none", awaiting: false })).toBe(
      "under_review",
    );
  });

  test("an under_review task that is held reads as the hold word", () => {
    expect(taskStatus({ lifecycle: "under_review", hold: "blocked", awaiting: false })).toBe(
      "blocked",
    );
    expect(taskStatus({ lifecycle: "under_review", hold: "parked", awaiting: false })).toBe(
      "parked",
    );
  });

  test("every axis combination projects to exactly one valid word", () => {
    for (const lifecycle of LIFECYCLE_VALUES) {
      for (const hold of HOLD_VALUES) {
        for (const awaiting of [true, false]) {
          const word = taskStatus({ lifecycle, hold, awaiting });
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

  test("under_review ranks just under in_progress, above ready (MMR-84)", () => {
    // in_progress still wins
    expect(interpret({ in_progress: 1, under_review: 3 })).toBe("in_progress");
    // but under_review beats ready/awaiting/blocked/parked
    expect(interpret({ under_review: 1, ready: 5, awaiting: 2, blocked: 1, parked: 1 })).toBe(
      "under_review",
    );
    // a phase finishing through review reads as under_review, not done
    expect(interpret({ done: 3, under_review: 1 })).toBe("under_review");
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
