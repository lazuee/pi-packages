import { describe, expect, test } from "bun:test";

import {
  prepareHistoryArguments,
  prepareNotesArguments,
} from "../src/notes/tool-contracts.ts";

/**
 * Some harnesses hand numeric tool arguments over as text. Those must be read
 * as numbers, while anything that only looks numeric still fails validation.
 */
describe("numeric tool arguments given as strings", () => {
  test("accepts a string limit on history search", () => {
    expect(
      prepareHistoryArguments({ action: "search", query: "x", limit: "3" })
    ).toEqual({ action: "search", query: "x", limit: 3 });
  });

  test("accepts a string limit on notes list", () => {
    expect(prepareNotesArguments({ action: "list", limit: "5" })).toEqual({
      action: "list",
      limit: 5,
    });
  });

  test("coerces an alias onto its canonical field", () => {
    expect(prepareNotesArguments({ action: "list", max_results: "7" })).toEqual(
      {
        action: "list",
        limit: 7,
      }
    );
  });

  test.each([
    ["non-numeric", "5x"],
    ["below the minimum", "0"],
    ["negative", "-2"],
  ])("still rejects %s", (_case, limit) => {
    expect(() =>
      prepareHistoryArguments({ action: "search", query: "x", limit })
    ).toThrow("Invalid history limit");
  });

  test("leaves a real number alone", () => {
    expect(
      prepareHistoryArguments({ action: "search", query: "x", limit: 4 })
    ).toEqual({ action: "search", query: "x", limit: 4 });
  });

  test("rejects a fraction", () => {
    expect(() =>
      prepareHistoryArguments({ action: "search", query: "x", limit: 1.5 })
    ).toThrow("Invalid history limit");
  });
});
