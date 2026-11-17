import { describe, expect, test } from "bun:test";

import { parseBoardRequest } from "../src/board/contract.ts";

const MESSAGE_ID = "6e07ff8c-0000-4000-8000-000000000000";

/**
 * Some harnesses hand numeric tool arguments over as text. Those must be read
 * as numbers, while anything that only looks numeric still fails validation.
 */
describe("numeric board arguments given as strings", () => {
  test("accepts a string limit", () => {
    expect(
      parseBoardRequest({
        action: "list_threads",
        channel_name: "c",
        limit: "2",
      })
    ).toMatchObject({ limit: 2 });
  });

  test("accepts a string limit_chars", () => {
    expect(
      parseBoardRequest({
        action: "read_post",
        message_id: MESSAGE_ID,
        limit_chars: "50",
      })
    ).toMatchObject({ limit_chars: 50 });
  });

  test("accepts a string offset_chars", () => {
    expect(
      parseBoardRequest({
        action: "read_post",
        message_id: MESSAGE_ID,
        offset_chars: "0",
      })
    ).toMatchObject({ offset_chars: 0 });
  });

  test.each([
    ["non-numeric", "2x"],
    ["below the minimum", "0"],
    ["negative", "-1"],
  ])("still rejects %s", (_case, limit) => {
    expect(() =>
      parseBoardRequest({ action: "list_threads", channel_name: "c", limit })
    ).toThrow("Invalid board request");
  });

  test("leaves a real number alone", () => {
    expect(
      parseBoardRequest({ action: "list_threads", channel_name: "c", limit: 4 })
    ).toMatchObject({ limit: 4 });
  });

  test("still rejects a fraction", () => {
    expect(() =>
      parseBoardRequest({
        action: "list_threads",
        channel_name: "c",
        limit: 1.5,
      })
    ).toThrow("Invalid board request");
  });
});
